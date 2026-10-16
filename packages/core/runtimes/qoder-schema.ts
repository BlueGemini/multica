import { z } from "zod";
import { parseWithFallback } from "../api/schema";

const schema = z
  .object({
    configured: z.boolean().catch(false),
    available: z.boolean().catch(false),
    name: z.string().catch(""),
    base_url: z.string().catch(""),
    environment_id: z.string().catch(""),
    has_token: z.boolean().catch(false),
    repositories: z.array(z.string()).catch([]),
    enabled: z.boolean().catch(false),
    status: z.string().catch(""),
    last_error: z.string().catch(""),
  })
  .transform((v) => ({
    configured: v.configured,
    available: v.available,
    name: v.name,
    baseUrl: v.base_url,
    environmentId: v.environment_id,
    hasToken: v.has_token,
    repositories: v.repositories,
    enabled: v.enabled,
    status: v.status,
    lastError: v.last_error,
  }));
export type QoderConnection = z.output<typeof schema>;
export type QoderInput = {
  name: string;
  baseUrl: string;
  environmentId: string;
  qoderToken: string;
  githubTokens: Record<string, string>;
};
export function parseQoderConnection(data: unknown): QoderConnection {
  return parseWithFallback(
    data,
    schema,
    {
      configured: false,
      available: false,
      name: "",
      baseUrl: "",
      environmentId: "",
      hasToken: false,
      repositories: [],
      enabled: false,
      status: "",
      lastError: "",
    },
    { endpoint: "qoder" },
  );
}

const catalogSchema = z.object({
  items: z.array(z.object({ id: z.string().min(1), name: z.string() })),
});
export type QoderCatalogItem = z.output<typeof catalogSchema>["items"][number];
export function parseQoderCatalog(data: unknown): QoderCatalogItem[] {
  return parseWithFallback(
    data,
    catalogSchema,
    { items: [] },
    { endpoint: "qoder/catalog" },
  ).items;
}
