import { errorBody, isAbort, request, SUPERVISOR_CORE_URL } from "./ha-core.ts";
import { logger } from "./log.ts";
import { toJson } from "./text.ts";

const log = logger("ha-todo");

const STATUS_TIMEOUT_MS = 5000;
// One item; Bring refreshes its list after every item, so this is not much shorter than a status check.
export const ITEM_TIMEOUT_MS = 10_000;
// TodoListEntityFeature in Home Assistant (homeassistant/components/todo/const.py).
const CREATE_TODO_ITEM = 1;
const SET_DESCRIPTION_ON_ITEM = 64;

// A to-do list in Home Assistant, e.g. a Bring list. `description`: the list keeps a description per item (Bring calls
// it "Spezifikation"); without it the amount goes into the item name, because Home Assistant refuses the field.
export type TodoList = { entity_id: string; name: string; description: boolean };
// An item that is still to buy. description: null when the list has none or it is empty.
export type OpenTodoItem = { summary: string; description: string | null };
export type TodoStatus = { lists: TodoList[]; reason: "disabled" | "no_list" | "unreachable" | null };
export class TodoError extends Error {
  constructor(public reason: "disabled" | "timeout" | "unreachable" | "bad_response") {
    super(reason);
  }
}
export type HaTodo = {
  status(): Promise<TodoStatus>;
  // The items still to buy (status needs_action).
  openItems(entityId: string): Promise<OpenTodoItem[]>;
  add(list: TodoList, name: string, spec: string | null): Promise<void>;
};

// Talks to Home Assistant's todo services through the Supervisor's Core proxy (see ha-core.ts). Item names never go
// into the log: they come from recipes. `token` null (dev, tests) -> disabled. `baseUrl` is for tests.
export function createHaTodo(token: string | null, baseUrl = SUPERVISOR_CORE_URL, itemTimeoutMs = ITEM_TIMEOUT_MS): HaTodo {
  async function call(service: string, body: object, timeout: number): Promise<any> {
    if (!token) throw new TodoError("disabled");
    let res: Response;
    try {
      res = await request(
        `services/todo/${service}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: toJson(body) },
        token,
        baseUrl,
        timeout,
      );
    } catch (e) {
      if (isAbort(e)) {
        log.warn("call_timeout", { service, limit_ms: timeout });
        throw new TodoError("timeout");
      }
      log.error("call_unreachable", { service, err: e });
      throw new TodoError("unreachable");
    }
    if (!res.ok) {
      // Errors of add_item may repeat the item name (Bring: "Failed to save item …"), so their body is not logged.
      log.error("call_failed", { service, status: res.status, body: service === "add_item" ? undefined : await errorBody(res) });
      throw new TodoError("unreachable");
    }
    try {
      return await res.json();
    } catch {
      throw new TodoError("bad_response");
    }
  }

  return {
    async status() {
      if (!token) return { lists: [], reason: "disabled" };
      try {
        const res = await request("states", { method: "GET" }, token, baseUrl, STATUS_TIMEOUT_MS);
        if (!res.ok) {
          log.warn("status_check_failed", { status: res.status, body: await errorBody(res) });
          return { lists: [], reason: "unreachable" };
        }
        const states = (await res.json()) as unknown;
        const lists = Array.isArray(states) ? states.flatMap(toList) : [];
        lists.sort((a, b) => a.name.localeCompare(b.name, "de"));
        return { lists, reason: lists.length ? null : "no_list" };
      } catch (e) {
        log.warn("status_check_failed", { err: e });
        return { lists: [], reason: "unreachable" };
      }
    },

    async openItems(entityId) {
      const body = await call("get_items?return_response", { entity_id: entityId, status: ["needs_action"] }, STATUS_TIMEOUT_MS);
      const items = body?.service_response?.[entityId]?.items;
      if (!Array.isArray(items)) throw new TodoError("bad_response");
      return items.flatMap((i: any): OpenTodoItem[] =>
        typeof i?.summary === "string" ? [{ summary: i.summary, description: typeof i.description === "string" && i.description ? i.description : null }] : [],
      );
    },

    async add(list, name, spec) {
      const item = spec && !list.description ? `${name} (${spec})` : name;
      // Without the feature, even an empty description is refused, so the field is left out entirely.
      const description = spec && list.description ? { description: spec } : {};
      await call("add_item", { entity_id: list.entity_id, item, ...description }, itemTimeoutMs);
    },
  };
}

function toList(s: any): TodoList[] {
  if (typeof s?.entity_id !== "string" || !s.entity_id.startsWith("todo.") || s.state === "unavailable") return [];
  const features = Number(s.attributes?.supported_features) || 0;
  if (!(features & CREATE_TODO_ITEM)) return [];
  const name = typeof s.attributes?.friendly_name === "string" && s.attributes.friendly_name.trim() ? s.attributes.friendly_name.trim() : s.entity_id;
  return [{ entity_id: s.entity_id, name, description: !!(features & SET_DESCRIPTION_ON_ITEM) }];
}
