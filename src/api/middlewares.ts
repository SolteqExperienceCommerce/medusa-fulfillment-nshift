import { defineMiddlewares } from "@medusajs/framework/http"
import { validateAndTransformBody } from "@medusajs/framework/http"
import { PostDeliveryOptionsSchema } from "./store/nshift/delivery-options/validators"

export default defineMiddlewares({
  routes: [
    {
      matcher: "/store/nshift/delivery-options",
      method: "POST",
      middlewares: [validateAndTransformBody(PostDeliveryOptionsSchema)],
    },
  ],
})
