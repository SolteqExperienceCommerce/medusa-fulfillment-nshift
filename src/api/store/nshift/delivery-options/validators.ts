import { z } from "zod"

export const PostDeliveryOptionsSchema = z.object({
  cart_id: z.string(),
})

export type PostDeliveryOptionsSchema = z.infer<typeof PostDeliveryOptionsSchema>
