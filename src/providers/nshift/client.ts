import { MedusaError } from "@medusajs/framework/utils"
import {
  CreatePartialShipmentRequest,
  CreateSessionRequest,
  CreateSessionResponse,
  FetchDeliveryOptionsRequest,
  FetchDeliveryOptionsResponse,
  NShiftIssue,
  NShiftOptions,
  NShiftProblemResponse,
  NShiftTokenResponse,
  PartialShipmentResponse,
} from "./types"

const DEFAULT_AUTH_URL = "https://account.nshiftportal.com/idp/connect/token"
const DEFAULT_API_BASE_URL = "https://api.nshiftportal.com/checkout"
const DEFAULT_TIMEOUT_MS = 15_000

/** Refresh the access token this many seconds before nShift expires it. */
const TOKEN_REFRESH_MARGIN_SECONDS = 300

/**
 * Error raised for any non-2xx response from nShift. It keeps the HTTP status and
 * the `issues[]` array from nShift's problem response so callers can tell a
 * recoverable context problem (e.g. `MISSING_POSTAL_CODE`) from a hard failure.
 *
 * The Medusa error type is `INVALID_DATA` so an upstream problem surfaces as a
 * `400` with a readable message instead of an opaque `500`.
 */
export class NShiftApiError extends MedusaError {
  readonly status: number
  readonly issues: NShiftIssue[]

  constructor(message: string, status: number, issues: NShiftIssue[] = []) {
    super(MedusaError.Types.INVALID_DATA, message)
    this.status = status
    this.issues = issues
  }

  /** True when nShift rejected the payload because the receiver/context is incomplete. */
  get isInvalidInput(): boolean {
    return this.status === 400 || this.status === 404 || this.status === 422
  }

  hasIssue(issueCode: string): boolean {
    return this.issues.some((issue) => issue.issueCode === issueCode)
  }
}

const describeIssues = (issues: NShiftIssue[]): string =>
  issues
    .map((issue) =>
      [issue.issueCode, issue.location, issue.description]
        .filter((part): part is string => !!part)
        .join(" @ ")
    )
    .join("; ")

export class NShiftClient {
  private readonly options: NShiftOptions
  private readonly authUrl: string
  private readonly apiBaseUrl: string
  private readonly timeoutMs: number

  private accessToken: string | null = null
  private tokenExpiresAt = 0
  /** In-flight token request, shared so concurrent calls issue a single token. */
  private tokenRequest: Promise<string> | null = null

  constructor(options: NShiftOptions) {
    this.options = options
    this.authUrl = options.auth_url || DEFAULT_AUTH_URL
    this.apiBaseUrl = (options.api_base_url || DEFAULT_API_BASE_URL).replace(/\/+$/, "")
    this.timeoutMs = options.request_timeout_ms ?? DEFAULT_TIMEOUT_MS
  }

  // ── Authentication ──

  /**
   * Returns a valid access token, refreshing it when it is close to expiry.
   * Tokens are valid for one hour; concurrent callers share a single refresh.
   */
  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) {
      return this.accessToken
    }

    this.tokenRequest ??= this.requestAccessToken().finally(() => {
      this.tokenRequest = null
    })

    return this.tokenRequest
  }

  private async requestAccessToken(): Promise<string> {
    const requestedAt = Date.now()

    const response = await this.fetchWithTimeout(this.authUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_id: this.options.client_id,
        client_secret: this.options.client_secret,
        grant_type: "client_credentials",
      }).toString(),
    })

    if (!response.ok) {
      const text = await response.text().catch(() => "")
      throw new NShiftApiError(
        `nShift authentication failed (${response.status}): ${text || response.statusText}. ` +
          `Check client_id / client_secret and that the client has the "Public checkout API" scope.`,
        response.status
      )
    }

    const data = (await response.json()) as NShiftTokenResponse
    if (!data.access_token) {
      throw new NShiftApiError(
        "nShift authentication succeeded but returned no access_token.",
        response.status
      )
    }

    this.accessToken = data.access_token
    const lifetimeSeconds = Math.max(
      (data.expires_in || 0) - TOKEN_REFRESH_MARGIN_SECONDS,
      TOKEN_REFRESH_MARGIN_SECONDS
    )
    this.tokenExpiresAt = requestedAt + lifetimeSeconds * 1000

    return data.access_token
  }

  // ── Request helpers ──

  private async fetchWithTimeout(
    url: string,
    init: RequestInit
  ): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.timeoutMs) })
    } catch (error) {
      // Turn transport failures (DNS, TLS, timeout) into a typed Medusa error so
      // they surface as a readable 400 rather than an unhandled 500.
      const reason = error instanceof Error ? error.message : String(error)
      const isTimeout = error instanceof Error && error.name === "TimeoutError"
      throw new NShiftApiError(
        isTimeout
          ? `nShift request to ${url} timed out after ${this.timeoutMs}ms.`
          : `nShift request to ${url} failed: ${reason}`,
        0
      )
    }
  }

  private async sendRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken()
    const url = `${this.apiBaseUrl}${path}`

    const response = await this.fetchWithTimeout(url, {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
    })

    if (!response.ok) {
      throw await this.buildApiError(response, path)
    }

    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  private async buildApiError(
    response: Response,
    path: string
  ): Promise<NShiftApiError> {
    const rawBody = await response.text().catch(() => "")

    let problem: NShiftProblemResponse | null = null
    // nShift answers with `application/problem+json` for validation failures.
    if (rawBody && (response.headers.get("content-type") || "").includes("json")) {
      try {
        problem = JSON.parse(rawBody) as NShiftProblemResponse
      } catch {
        problem = null
      }
    }

    const issues = problem?.issues ?? []
    const detail = problem?.detail || problem?.title || rawBody || response.statusText
    const issueText = issues.length ? ` Issues: ${describeIssues(issues)}` : ""

    return new NShiftApiError(
      `nShift API error (${response.status}) on ${path}: ${detail}${issueText}`,
      response.status,
      issues
    )
  }

  // ── Session management ──

  /**
   * Creates a checkout session for the configured connection. Sessions stay valid
   * for four hours and every interaction extends that window.
   */
  async createSession(data: CreateSessionRequest): Promise<CreateSessionResponse> {
    return this.sendRequest<CreateSessionResponse>(
      `/options/v1/sessions/${encodeURIComponent(this.options.connection_id)}`,
      { method: "POST", body: JSON.stringify(data) }
    )
  }

  // ── Delivery Options ──

  /** Fetches the delivery options available within a session. */
  async fetchDeliveryOptions(
    sessionId: string,
    data: FetchDeliveryOptionsRequest
  ): Promise<FetchDeliveryOptionsResponse> {
    return this.sendRequest<FetchDeliveryOptionsResponse>(
      `/options/v1/shipping-options/${encodeURIComponent(sessionId)}`,
      { method: "POST", body: JSON.stringify(data) }
    )
  }

  // ── Partial Shipments ──

  /** Creates a partial shipment in nShift after the order is placed. */
  async createPartialShipment(
    data: CreatePartialShipmentRequest,
    sendToBookAndPrint?: boolean
  ): Promise<PartialShipmentResponse> {
    const params = new URLSearchParams({ "extended-result": "true" })
    if (sendToBookAndPrint) {
      params.set("send-to-book-and-print", "true")
    }

    return this.sendRequest<PartialShipmentResponse>(
      `/shipments/v1/shipments?${params.toString()}`,
      { method: "POST", body: JSON.stringify(data) }
    )
  }

  /** Fetches a partial shipment by its ID. */
  async getPartialShipment(shipmentId: string): Promise<PartialShipmentResponse> {
    return this.sendRequest<PartialShipmentResponse>(
      `/shipments/v1/shipments/${encodeURIComponent(shipmentId)}`
    )
  }

  /**
   * Deletes a partial shipment from nShift Checkout.
   * Note: this does not delete the shipment in your Book & Print platform.
   */
  async deletePartialShipment(shipmentId: string): Promise<void> {
    return this.sendRequest<void>(
      `/shipments/v1/shipments/${encodeURIComponent(shipmentId)}`,
      { method: "DELETE" }
    )
  }
}
