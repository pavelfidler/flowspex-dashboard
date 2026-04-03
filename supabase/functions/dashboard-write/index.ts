import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type DashboardAction =
  | "update_task"
  | "update_scope"
  | "create_mission"
  | "update_mission";

type Payload = {
  actor: "Pavel" | "Tim";
  action: DashboardAction;
  target_id?: number;
  data?: Record<string, unknown>;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

if (!SUPABASE_URL || !SERVICE_ROLE) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const sb = createClient(SUPABASE_URL, SERVICE_ROLE);

const CORS_HEADERS: Record<string, string> = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS_HEADERS });
}

function getScopeIdFromTask(task: Record<string, unknown> | null) {
  const scopeId = task?.scope_id;
  if (scopeId === null || scopeId === undefined) return null;
  const parsed = Number(scopeId);
  return Number.isFinite(parsed) ? parsed : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON payload" }, 400);
  }

  const { actor, action, target_id, data = {} } = payload;
  if (!["Pavel", "Tim"].includes(actor)) return json({ error: "Invalid actor" }, 403);

  try {
    let result: Record<string, unknown> | null = null;
    let activityTargetType = action.replace("update_", "").replace("create_", "");
    let activityTargetId = String(target_id ?? "");
    let activityDetails: Record<string, unknown> = { source: "dashboard_ui", ...data };
    let snapshotScopeId: number | null = null;

    if (action === "update_task") {
      if (!target_id) return json({ error: "target_id is required for update_task" }, 400);

      const { data: beforeTask, error: beforeErr } = await sb
        .from("flowspex_tasks")
        .select("*")
        .eq("id", target_id)
        .single();
      if (beforeErr || !beforeTask) return json({ error: "Task not found", details: beforeErr?.message }, 404);

      const updates = { ...data, updated_at: new Date().toISOString() };
      const { data: updatedRows, error: updateErr } = await sb
        .from("flowspex_tasks")
        .update(updates)
        .eq("id", target_id)
        .select();
      if (updateErr) return json({ error: updateErr.message }, 400);

      result = updatedRows?.[0] ?? null;
      snapshotScopeId = getScopeIdFromTask(result) ?? getScopeIdFromTask(beforeTask);

      if ("status" in data) {
        activityDetails = {
          ...activityDetails,
          from_status: beforeTask.status,
          to_status: (result as { status?: string } | null)?.status,
        };
      }
      if ("notes" in data) {
        activityDetails = {
          ...activityDetails,
          from_notes: beforeTask.notes ?? "",
          to_notes: (result as { notes?: string } | null)?.notes ?? "",
        };
      }
    } else if (action === "update_scope") {
      if (!target_id) return json({ error: "target_id is required for update_scope" }, 400);

      const { data: beforeScope, error: beforeErr } = await sb
        .from("flowspex_scopes")
        .select("*")
        .eq("id", target_id)
        .single();
      if (beforeErr || !beforeScope) return json({ error: "Scope not found", details: beforeErr?.message }, 404);

      const updates = { ...data, updated_at: new Date().toISOString() };
      const { data: updatedRows, error: updateErr } = await sb
        .from("flowspex_scopes")
        .update(updates)
        .eq("id", target_id)
        .select();
      if (updateErr) return json({ error: updateErr.message }, 400);

      result = updatedRows?.[0] ?? null;
      snapshotScopeId = target_id;

      if ("hill_position" in data) {
        activityDetails = {
          ...activityDetails,
          from_hill: beforeScope.hill_position,
          to_hill: (result as { hill_position?: number } | null)?.hill_position,
        };
      }
      if ("status" in data) {
        activityDetails = {
          ...activityDetails,
          from_status: beforeScope.status,
          to_status: (result as { status?: string } | null)?.status,
        };
      }
    } else if (action === "create_mission") {
      const missionPayload = {
        ...data,
        updated_at: new Date().toISOString(),
      };
      const { data: createdRows, error: createErr } = await sb
        .from("flowspex_missions")
        .insert(missionPayload)
        .select();
      if (createErr) return json({ error: createErr.message }, 400);

      result = createdRows?.[0] ?? null;
      activityTargetId = String((result as { id?: number } | null)?.id ?? "");
    } else if (action === "update_mission") {
      if (!target_id) return json({ error: "target_id is required for update_mission" }, 400);

      const { data: beforeMission, error: beforeErr } = await sb
        .from("flowspex_missions")
        .select("*")
        .eq("id", target_id)
        .single();
      if (beforeErr || !beforeMission) return json({ error: "Mission not found", details: beforeErr?.message }, 404);

      const missionPayload = {
        ...data,
        updated_at: new Date().toISOString(),
      };
      const { data: updatedRows, error: updateErr } = await sb
        .from("flowspex_missions")
        .update(missionPayload)
        .eq("id", target_id)
        .select();
      if (updateErr) return json({ error: updateErr.message }, 400);

      result = updatedRows?.[0] ?? null;
      if ("status" in data) {
        activityDetails = {
          ...activityDetails,
          from_status: beforeMission.status,
          to_status: (result as { status?: string } | null)?.status,
        };
      }
    } else {
      return json({ error: "Unknown action" }, 400);
    }

    await sb.from("flowspex_activity").insert({
      actor,
      action,
      target_type: activityTargetType,
      target_id: activityTargetId,
      details: activityDetails,
    });

    // Automatic hill snapshots for scope/task updates
    if (snapshotScopeId) {
      const { data: scope } = await sb
        .from("flowspex_scopes")
        .select("id, hill_position")
        .eq("id", snapshotScopeId)
        .single();

      if (scope) {
        await sb.from("flowspex_hill_snapshots").insert({
          scope_id: scope.id,
          hill_position: scope.hill_position,
          created_at: new Date().toISOString(),
        });
      }
    }

    return json({ ok: true, row: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown server error";
    return json({ error: message }, 500);
  }
});
