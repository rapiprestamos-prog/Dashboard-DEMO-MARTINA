// =====================================================================
//  Edge Function: agente-legal
//  Puente entre el Agente Legal (legal.html) y la IA de Anthropic.
//  El navegador lee los documentos de la carpeta Legal de OneDrive y manda aquí la
//  conversación; esta función revisa que el usuario tenga el módulo "agente_legal"
//  y le pasa la conversación a Claude. Los documentos no se guardan en ningún lado.
//
//  Secretos (Supabase → Edge Functions → Secrets):
//    ANTHROPIC_API_KEY   clave de la API de Anthropic (obligatoria)
//    ANTHROPIC_MODEL     modelo a usar (opcional; por defecto claude-sonnet-5-5)
//  La clave solo vive aquí, en el servidor: nunca en el HTML.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const clave = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
  const modelo = Deno.env.get("ANTHROPIC_MODEL") || "claude-sonnet-5-5";
  if (!clave) return json({ error: "Falta configurar ANTHROPIC_API_KEY en Supabase → Edge Functions → Secrets." }, 500);

  // ¿Quién llama y tiene el módulo?
  const comoUsuario = createClient(url, anon, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data: u, error: eu } = await comoUsuario.auth.getUser();
  if (eu || !u?.user?.email) return json({ error: "Sesión no válida" }, 401);
  const { data: puede, error: ep } = await comoUsuario.rpc("ma_tiene_modulo", { p_modulo: "agente_legal" });
  if (ep) return json({ error: "No se pudo revisar el permiso: " + ep.message }, 500);
  if (puede !== true) return json({ error: "Tu usuario no tiene acceso al Agente Legal" }, 403);

  // deno-lint-ignore no-explicit-any
  let b: any = {};
  try { b = await req.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  if (!Array.isArray(b.messages) || !b.messages.length) return json({ error: "Faltan los mensajes" }, 400);

  const cuerpo: Record<string, unknown> = {
    model: modelo,
    max_tokens: Math.min(Number(b.max_tokens) || 12000, 16000),
    messages: b.messages,
  };
  if (typeof b.system === "string" && b.system) cuerpo.system = b.system;
  if (Array.isArray(b.tools) && b.tools.length) cuerpo.tools = b.tools;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": clave, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(cuerpo),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) return json({ error: "Error de la IA: " + (out?.error?.message || r.statusText) }, r.status === 429 || r.status === 529 ? 429 : 502);
  return json({ content: out.content || [], stop_reason: out.stop_reason || "" });
});
