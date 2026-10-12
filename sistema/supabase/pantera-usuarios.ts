// =====================================================================
//  Edge Function: pantera-usuarios
//  Crear y administrar usuarios desde el dashboard (solo la administradora).
//
//  Acciones (POST JSON {accion, ...}):
//    listar                                   → usuarios con su rol, estado y último ingreso
//    crear   {email, password, nombre, rol}   → crea la cuenta (confirmada) y su permiso
//    clave   {email, password}                → cambia la contraseña
//    eliminar {email}                         → borra la cuenta y su permiso
//  (Cambiar rol o activar/desactivar se hace con la función de base ma_usuario_guardar.)
//
//  Variables que Supabase ya trae en toda Edge Function:
//    SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
//  La service_role vive solo aquí, en el servidor: nunca en el HTML.
// =====================================================================
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const ROLES = ["admin", "editor", "lector"];
const emailOk = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // 1) ¿Quién llama? (con el token del propio usuario, respetando RLS)
  const comoUsuario = createClient(url, anon, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: u, error: eu } = await comoUsuario.auth.getUser();
  if (eu || !u?.user?.email) return json({ error: "Sesión no válida" }, 401);
  const yo = u.user.email.toLowerCase();

  // 2) Solo la administradora activa puede usar esta función
  const admin = createClient(url, service, { auth: { persistSession: false } });
  const { data: perfil } = await admin.from("ma_usuarios").select("rol, activo").eq("email", yo).maybeSingle();
  if (!perfil || perfil.rol !== "admin" || !perfil.activo) return json({ error: "Solo la administradora puede manejar usuarios" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { return json({ error: "Cuerpo inválido" }, 400); }
  const accion = String(body.accion ?? "");
  const email = String(body.email ?? "").trim().toLowerCase();

  try {
    if (accion === "listar") {
      const cuentas: Array<{ email?: string; last_sign_in_at?: string | null; created_at?: string }> = [];
      for (let page = 1; page < 50; page++) {
        const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
        if (error) throw error;
        cuentas.push(...data.users);
        if (data.users.length < 200) break;
      }
      const { data: permisos, error } = await admin.from("ma_usuarios").select("*");
      if (error) throw error;
      const porEmail = new Map(cuentas.map((c) => [String(c.email).toLowerCase(), c]));
      const filas = (permisos ?? []).map((p) => ({
        email: p.email, nombre: p.nombre, rol: p.rol, activo: p.activo, modulos: p.modulos,
        cuenta: porEmail.has(p.email), ultimo_ingreso: porEmail.get(p.email)?.last_sign_in_at ?? null,
      }));
      // cuentas que existen en Authentication pero sin permiso en el dashboard
      cuentas.forEach((c) => { const e = String(c.email).toLowerCase(); if (!filas.some((f) => f.email === e)) filas.push({ email: e, nombre: null, rol: null, activo: false, modulos: [], cuenta: true, ultimo_ingreso: c.last_sign_in_at ?? null }); });
      return json({ usuarios: filas.sort((a, b) => String(a.email).localeCompare(String(b.email))) });
    }

    if (accion === "crear") {
      const password = String(body.password ?? "");
      const nombre = String(body.nombre ?? "").trim() || null;
      const rol = String(body.rol ?? "lector");
      if (!emailOk(email)) return json({ error: "Correo no válido" }, 400);
      if (password.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
      if (!ROLES.includes(rol)) return json({ error: "Rol no válido" }, 400);
      const { error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { nombre } });
      if (error && !/already|registered|exists/i.test(error.message)) throw error;
      const { error: e2 } = await admin.from("ma_usuarios").upsert({ email, nombre, rol, activo: true, modulos: ["martina"] }, { onConflict: "email" });
      if (e2) throw e2;
      return json({ ok: true, yaExistia: !!error });
    }

    if (accion === "clave") {
      const password = String(body.password ?? "");
      if (password.length < 8) return json({ error: "La contraseña debe tener al menos 8 caracteres" }, 400);
      const id = await idDe(admin, email);
      if (!id) return json({ error: "No existe una cuenta con ese correo" }, 404);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) throw error;
      return json({ ok: true });
    }

    if (accion === "eliminar") {
      if (email === yo) return json({ error: "No puedes eliminar tu propia cuenta" }, 400);
      const id = await idDe(admin, email);
      if (id) { const { error } = await admin.auth.admin.deleteUser(id); if (error) throw error; }
      const { error: e2 } = await admin.from("ma_usuarios").delete().eq("email", email);
      if (e2) throw e2;
      return json({ ok: true });
    }

    return json({ error: "Acción desconocida" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message ?? String(e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function idDe(admin: any, email: string): Promise<string | null> {
  for (let page = 1; page < 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x: { email?: string }) => String(x.email).toLowerCase() === email);
    if (u) return u.id;
    if (data.users.length < 200) return null;
  }
  return null;
}
