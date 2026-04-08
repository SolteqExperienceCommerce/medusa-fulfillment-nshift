import { MedusaError } from "@medusajs/framework/utils"
import {
  NShiftOptions,
  NShiftTokenResponse,
  CreateSessionRequest,
  CreateSessionResponse,
  FetchDeliveryOptionsRequest,
  FetchDeliveryOptionsResponse,
  CreatePartialShipmentRequest,
  PartialShipmentResponse,
} from "./types"

const AUTH_URL = "https://account.nshiftportal.com/idp/connect/token"
const OPTIONS_BASE_URL = "https://api.nshiftportal.com/checkout/options"
const SHIPMENTS_BASE_URL = "https://api.nshiftportal.com/checkout/shipments"

export class NShiftClient {
  private options: NShiftOptions
  private accessToken: string | null = null
  private tokenExpiresAt: number = 0

  constructor(options: NShiftOptions) {
    this.options = options
  }

  // ── Authentication ──

  /**
   * Retrieves a valid access token, refreshing if expired.
   * Tokens are valid for 1 hour. We refresh 5 minutes early to avoid edge cases.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && now < this.tokenExpiresAt) {
      return this.accessToken
    }

    let nshiftClientSecret = (typeof this.options.client_secret === "undefined" || this.options.client_secret === null) 
      ? '{{REPLACE_THIS_WITH_CLIENT_SECRET_AND_LEAVE_EMPTY_IN_.env_SINCE_ENV_VARIABLES_BREAK_BECAUSE_OF_$_AND_@_EVEN_THOUGH_IT_IS_ESCAPED 🤷‍♂️ lol, need to find a solution}}' 
      : this.options.client_secret; 

    const response = await fetch(AUTH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_id: this.options.client_id,
        client_secret: nshiftClientSecret,
        grant_type: "client_credentials",
      }).toString(),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift authentication failed: ${response.status} ${text}`
      )
    }

    const data = (await response.json()) as NShiftTokenResponse
    this.accessToken = data.access_token
    // Refresh 5 minutes before actual expiry
    this.tokenExpiresAt = now + (data.expires_in - 300) * 1000

    return this.accessToken
  }

  // ── Generic request helper ──

  private async sendRequest<T>(
    baseUrl: string,
    path: string,
    options?: RequestInit
  ): Promise<T> {
    const token = await this.getAccessToken()

    const response = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        ...options?.headers,
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    })

    if (!response.ok) {
      const contentType = response.headers.get("content-type")
      let errorMessage: string
      if (contentType?.includes("application/json")) {
        const errorJson = (await response.json()) as Record<string, unknown>
        errorMessage = (errorJson.detail as string) || (errorJson.message as string) || JSON.stringify(errorJson)
      } else {
        errorMessage = await response.text()
      }
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `nShift API error (${response.status}): ${errorMessage}`
      )
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return undefined as T
    }

    return (await response.json()) as T
  }

  // ── Session management ──

  /**
   * Creates a checkout session for a given connection ID.
   * Sessions are valid for 4 hours.
   */
  async createSession(
    data: CreateSessionRequest
  ): Promise<CreateSessionResponse> {
    return this.sendRequest<CreateSessionResponse>(
      OPTIONS_BASE_URL,
      `/v1/sessions/${this.options.connection_id}`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
  }

  // ── Delivery Options ──

  /**
   * Fetches available delivery options for a session.
   */
  async fetchDeliveryOptions(
    sessionId: string,
    data: FetchDeliveryOptionsRequest
  ): Promise<FetchDeliveryOptionsResponse> {
    return this.sendRequest<FetchDeliveryOptionsResponse>(
      OPTIONS_BASE_URL,
      `/v1/shipping-options/${sessionId}`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
  }

  // ── Partial Shipments ──

  /**
   * Creates a partial shipment in nShift after the order is placed.
   */
  async createPartialShipment(
    data: CreatePartialShipmentRequest,
    sendToBookAndPrint?: boolean
  ): Promise<PartialShipmentResponse> {
    const params = new URLSearchParams()
    params.set("extended-result", "true")
    if (sendToBookAndPrint) {
      params.set("send-to-book-and-print", "true")
    }

    return this.sendRequest<PartialShipmentResponse>(
      SHIPMENTS_BASE_URL,
      `/v1/shipments?${params.toString()}`,
      {
        method: "POST",
        body: JSON.stringify(data),
      }
    )
  }

  /**
   * Fetches a partial shipment by its ID.
   */
  async getPartialShipment(shipmentId: string): Promise<PartialShipmentResponse> {
    return this.sendRequest<PartialShipmentResponse>(
      SHIPMENTS_BASE_URL,
      `/v1/shipments/${shipmentId}`
    )
  }

  /**
   * Deletes a partial shipment from nShift.
   * Note: This does not delete the shipment in your Book&Print platform.
   */
  async deletePartialShipment(shipmentId: string): Promise<void> {
    return this.sendRequest<void>(
      SHIPMENTS_BASE_URL,
      `/v1/shipments/${shipmentId}`,
      {
        method: "DELETE",
      }
    )
  }
}
