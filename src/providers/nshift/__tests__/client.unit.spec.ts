import { NShiftApiError, NShiftClient } from "../client"
import { NShiftOptions } from "../types"

const options: NShiftOptions = {
  client_id: "cid",
  client_secret: "secret",
  connection_id: "conn/1",
  api_base_url: "https://nshift.test/checkout/",
  auth_url: "https://auth.nshift.test/token",
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

type RecordedCall = { url: string; method: string; body: unknown }

/**
 * Replaces `fetch`: the token endpoint always succeeds, every API call is recorded
 * and answered with `apiResponse`.
 */
const mockFetch = (apiResponse: () => Response) => {
  const calls: RecordedCall[] = []

  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === options.auth_url) {
      return jsonResponse({ access_token: "token", expires_in: 3600, token_type: "Bearer" })
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    })
    return apiResponse()
  })

  return calls
}

const base = { currencyCode: "EUR", languageCode: "en", localeId: "en-GB" }
const receiver = { country: "FI", postalCode: "00100" }

afterEach(() => jest.restoreAllMocks())

describe("NShiftClient", () => {
  it("updates a session with PUT", async () => {
    const calls = mockFetch(() => jsonResponse({ sessionId: "s 1", uniqueUserId: "u" }))
    const client = new NShiftClient(options)

    const result = await client.updateSession("s 1", {
      ...base,
      preselectedStoreId: "store-1",
      includeInConversionRate: true,
    })

    expect(result.uniqueUserId).toBe("u")
    expect(calls).toEqual([
      {
        url: "https://nshift.test/checkout/options/v1/sessions/s%201",
        method: "PUT",
        body: { ...base, preselectedStoreId: "store-1", includeInConversionRate: true },
      },
    ])
  })

  it("creates a split session on the configured connection", async () => {
    const calls = mockFetch(() =>
      jsonResponse({ sessionId: "s1", subShipments: [{ subShipmentId: "s1" }] })
    )
    const client = new NShiftClient(options)

    const body = { ...base, receiver, subShipments: [{}, {}] }
    const result = await client.createSplitSession(body)

    expect(result.subShipments[0].subShipmentId).toBe("s1")
    expect(calls).toEqual([
      {
        url: "https://nshift.test/checkout/options/v1/split-shipments/sessions/conn%2F1",
        method: "POST",
        body,
      },
    ])
  })

  it("updates a split session with PUT", async () => {
    const calls = mockFetch(() => jsonResponse({ sessionId: "s1", subShipments: [] }))
    const client = new NShiftClient(options)

    const body = { ...base, receiver, subShipments: [{ subShipmentId: "s1" }, {}] }
    await client.updateSplitSession("s1", body)

    expect(calls).toEqual([
      {
        url: "https://nshift.test/checkout/options/v1/split-shipments/sessions/s1",
        method: "PUT",
        body,
      },
    ])
  })

  it("fetches split delivery options", async () => {
    const calls = mockFetch(() =>
      jsonResponse({ sessionId: "s1", subShipments: [{ subShipmentId: "s1", options: [] }] })
    )
    const client = new NShiftClient(options)

    const body = { ...base, receiver, subShipments: [{ subShipmentId: "s1" }] }
    const result = await client.fetchSplitDeliveryOptions("s/1", body)

    expect(result.subShipments).toHaveLength(1)
    expect(calls).toEqual([
      {
        url: "https://nshift.test/checkout/options/v1/split-shipments/shipping-options/s%2F1",
        method: "POST",
        body,
      },
    ])
  })

  it("creates split partial shipments with the extended result", async () => {
    const calls = mockFetch(() => jsonResponse({ shipments: [{ id: "ship-1" }] }))
    const client = new NShiftClient(options)

    const body = {
      sessionId: "s1",
      receiver,
      subShipments: [{ subShipmentId: "s1", orderId: "order_1", optionId: "posti" }],
    }
    const result = await client.createSplitPartialShipments(body)

    expect(result.shipments[0].id).toBe("ship-1")
    expect(calls).toEqual([
      {
        url:
          "https://nshift.test/checkout/shipments/v1/split-shipments/shipments" +
          "?extended-result=true",
        method: "POST",
        body,
      },
    ])
  })

  it("forwards send-to-book-and-print on split shipments", async () => {
    const calls = mockFetch(() => jsonResponse({ shipments: [] }))
    const client = new NShiftClient(options)

    await client.createSplitPartialShipments(
      { sessionId: "s1", receiver, subShipments: [] },
      true
    )

    expect(calls[0].url).toBe(
      "https://nshift.test/checkout/shipments/v1/split-shipments/shipments" +
        "?extended-result=true&send-to-book-and-print=true"
    )
  })

  it("keeps the single partial shipment endpoint unchanged", async () => {
    const calls = mockFetch(() => jsonResponse({ id: "ship-1" }))
    const client = new NShiftClient(options)

    await client.createPartialShipment(
      { orderId: "o", sessionId: "s1", optionId: "posti", receiver },
      true
    )

    expect(calls[0].url).toBe(
      "https://nshift.test/checkout/shipments/v1/shipments" +
        "?extended-result=true&send-to-book-and-print=true"
    )
  })

  it("raises a typed error carrying status and issues", async () => {
    mockFetch(() =>
      jsonResponse(
        {
          title: "Not found",
          issues: [{ issueCode: "SESSION_NOT_FOUND", severity: "ERROR" }],
        },
        404
      )
    )
    const client = new NShiftClient(options)

    const error = await client
      .fetchSplitDeliveryOptions("gone", { ...base, receiver, subShipments: [] })
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(NShiftApiError)
    expect((error as NShiftApiError).status).toBe(404)
    expect((error as NShiftApiError).hasIssue("SESSION_NOT_FOUND")).toBe(true)
  })
})
