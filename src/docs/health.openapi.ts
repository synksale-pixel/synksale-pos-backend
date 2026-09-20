import { registry } from "../config/openapi.registry";
import {
  HealthApiDataSchema,
  HealthInfraSchema,
  successEnvelope,
} from "../validators/responses";
import { API, json } from "./common";

registry.registerPath({
  method: "get",
  path: "/health",
  tags: ["Health"],
  summary: "Infrastructure liveness check",
  description:
    "Public. Lives OUTSIDE the versioned prefix (`/health`, not `/api/v1/health`) and does NOT use the standard ApiResponse envelope. Intended for load balancers/uptime monitors.",
  responses: {
    200: { description: "Server is up.", content: json(HealthInfraSchema) },
  },
});

registry.registerPath({
  method: "get",
  path: `${API}/health`,
  tags: ["Health"],
  summary: "API health check",
  description:
    "Public. Uses the standard ApiResponse envelope. No authentication.",
  responses: {
    200: {
      description: "API is up.",
      content: json(
        successEnvelope("ApiHealthResponse", HealthApiDataSchema, "OK")
      ),
    },
  },
});
