-- =====================================================================
--  M&A Capital · Dashboard Interno Ultimate — Supabase
--  Tablas, roles, historial de ediciones, reversión y seguridad.
--
--  Pegar completo en: Supabase → SQL Editor → Run.
--  Se puede correr más de una vez (no borra datos).
--
--  Roles:
--    admin   crea usuarios, maneja permisos, revierte ediciones y quita meses
--    editor  sube información
--    lector  solo ve los reportes
--
--  Regla de oro: el navegador NUNCA escribe directo en las tablas.
--  Toda escritura pasa por funciones de la base (security definer) que
--  revisan el rol y guardan cada edición en el historial.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Tablas
-- ---------------------------------------------------------------------
create table if not exists public.ma_carpetas (
  id          bigint generated always as identity primary key,
  modulo      text not null,
  nombre      text not null,
  ruta        text not null,
  cuenta      text,
  activa      boolean not null default true,
  creada      timestamptz not null default now(),
  unique (modulo, ruta)
);

create table if not exists public.ma_archivos (
  id          bigint generated always as identity primary key,
  carpeta_id  bigint not null references public.ma_carpetas(id) on delete cascade,
  ruta        text not null,
  nombre      text not null,
  anio        text,
  mes         text,
  tamano      bigint,
  modificado  timestamptz,
  storage     text not null,
  hash        text,
  sincronizado timestamptz not null default now(),
  unique (carpeta_id, ruta)
);
create index if not exists ma_archivos_carpeta_idx on public.ma_archivos(carpeta_id, anio, mes);

create table if not exists public.ma_usuarios (
  email       text primary key,
  nombre      text,
  rol         text not null default 'lector',
  modulos     text[] not null default '{martina}',
  creado      timestamptz not null default now()
);
alter table public.ma_usuarios add column if not exists activo boolean not null default true;
alter table public.ma_usuarios drop constraint if exists ma_usuarios_rol_chk;
alter table public.ma_usuarios add constraint ma_usuarios_rol_chk check (rol in ('admin','editor','lector'));

-- Historial: una fila por carga / quitar mes / reversión
create table if not exists public.ma_ediciones (
  id            bigint generated always as identity primary key,
  carpeta_id    bigint references public.ma_carpetas(id) on delete set null,
  tipo          text not null check (tipo in ('carga','quitar_mes','reversion')),
  usuario       text not null,
  descripcion   text,
  anio          text,          -- mes de registro (lo da el último balance cargado)
  mes           text,
  inicio        timestamptz not null default now(),
  fin           timestamptz,
  nuevos        int not null default 0,
  cambiados     int not null default 0,
  quitados      int not null default 0,
  revierte_a    bigint references public.ma_ediciones(id),
  revertida_por bigint references public.ma_ediciones(id),
  revertida_en  timestamptz
);
create index if not exists ma_ediciones_carpeta_idx on public.ma_ediciones(carpeta_id, inicio desc);

-- Detalle de cada edición: qué archivo, qué acción y cómo estaba antes / después
create table if not exists public.ma_edicion_items (
  id          bigint generated always as identity primary key,
  edicion_id  bigint not null references public.ma_ediciones(id) on delete cascade,
  accion      text not null check (accion in ('alta','cambio','baja')),
  ruta        text not null,
  antes       jsonb,
  despues     jsonb,
  creado      timestamptz not null default now()
);
create index if not exists ma_edicion_items_ed_idx on public.ma_edicion_items(edicion_id, id);

-- Bucket privado para los Excel (cada versión se guarda aparte para poder revertir)
insert into storage.buckets (id, name, public) values ('reportes','reportes', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2) Quién es el usuario conectado
-- ---------------------------------------------------------------------
create or replace function public.ma_email() returns text
language sql stable as $$ select lower(coalesce(auth.jwt() ->> 'email','')) $$;

create or replace function public.ma_rol() returns text
language sql stable security definer set search_path = public as $$
  select u.rol from public.ma_usuarios u where lower(u.email) = public.ma_email() and u.activo
$$;

create or replace function public.ma_es_usuario() returns boolean
language sql stable security definer set search_path = public as $$ select public.ma_rol() is not null $$;

create or replace function public.ma_es_editor() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.ma_rol() in ('admin','editor'), false) $$;

create or replace function public.ma_es_admin() returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(public.ma_rol() = 'admin', false) $$;

-- ---------------------------------------------------------------------
-- 3) Funciones de escritura (las únicas que pueden modificar datos)
-- ---------------------------------------------------------------------

-- Abre una edición de tipo "carga" (rol editor o admin)
create or replace function public.ma_edicion_iniciar(p_carpeta bigint, p_descripcion text, p_anio text, p_mes text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  if not public.ma_es_editor() then raise exception 'Sin permiso: se necesita rol editor o administradora'; end if;
  insert into public.ma_ediciones (carpeta_id, tipo, usuario, descripcion, anio, mes)
  values (p_carpeta, 'carga', public.ma_email(), p_descripcion, p_anio, p_mes) returning id into v_id;
  return v_id;
end $$;

-- Aplica un cambio de archivo dentro de una edición abierta y lo deja en el historial
-- p_accion: 'alta' | 'cambio' | 'baja'.  p_fila: columnas de ma_archivos (para baja basta {"ruta": ...})
create or replace function public.ma_edicion_aplicar(p_edicion bigint, p_accion text, p_fila jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare e public.ma_ediciones; v_antes jsonb; v_despues jsonb; v_ruta text := p_fila->>'ruta';
begin
  select * into e from public.ma_ediciones where id = p_edicion;
  if e.id is null then raise exception 'La edición % no existe', p_edicion; end if;
  if e.fin is not null then raise exception 'La edición % ya está cerrada', p_edicion; end if;
  if e.usuario <> public.ma_email() and not public.ma_es_admin() then raise exception 'La edición % es de otro usuario', p_edicion; end if;
  if not public.ma_es_editor() then raise exception 'Sin permiso: se necesita rol editor o administradora'; end if;

  select to_jsonb(a) - 'id' into v_antes from public.ma_archivos a where a.carpeta_id = e.carpeta_id and a.ruta = v_ruta;

  if p_accion in ('alta','cambio') then
    insert into public.ma_archivos (carpeta_id, ruta, nombre, anio, mes, tamano, modificado, storage, hash, sincronizado)
    values (e.carpeta_id, v_ruta, p_fila->>'nombre', p_fila->>'anio', p_fila->>'mes', (p_fila->>'tamano')::bigint,
            (p_fila->>'modificado')::timestamptz, p_fila->>'storage', p_fila->>'hash', now())
    on conflict (carpeta_id, ruta) do update set nombre = excluded.nombre, anio = excluded.anio, mes = excluded.mes,
      tamano = excluded.tamano, modificado = excluded.modificado, storage = excluded.storage, hash = excluded.hash, sincronizado = now();
    select to_jsonb(a) - 'id' into v_despues from public.ma_archivos a where a.carpeta_id = e.carpeta_id and a.ruta = v_ruta;
    insert into public.ma_edicion_items (edicion_id, accion, ruta, antes, despues)
    values (p_edicion, case when v_antes is null then 'alta' else 'cambio' end, v_ruta, v_antes, v_despues);
  elsif p_accion = 'baja' then
    if v_antes is null then return; end if;
    delete from public.ma_archivos where carpeta_id = e.carpeta_id and ruta = v_ruta;
    insert into public.ma_edicion_items (edicion_id, accion, ruta, antes, despues) values (p_edicion, 'baja', v_ruta, v_antes, null);
  else
    raise exception 'Acción no válida: %', p_accion;
  end if;
end $$;

-- Cierra la edición y guarda los totales
create or replace function public.ma_edicion_cerrar(p_edicion bigint)
returns void language plpgsql security definer set search_path = public as $$
declare e public.ma_ediciones;
begin
  select * into e from public.ma_ediciones where id = p_edicion;
  if e.id is null then raise exception 'La edición % no existe', p_edicion; end if;
  if e.usuario <> public.ma_email() and not public.ma_es_admin() then raise exception 'La edición % es de otro usuario', p_edicion; end if;
  update public.ma_ediciones set fin = now(),
    nuevos    = (select count(*) from public.ma_edicion_items where edicion_id = p_edicion and accion = 'alta'),
    cambiados = (select count(*) from public.ma_edicion_items where edicion_id = p_edicion and accion = 'cambio'),
    quitados  = (select count(*) from public.ma_edicion_items where edicion_id = p_edicion and accion = 'baja')
  where id = p_edicion;
  -- una edición sin cambios no deja rastro
  delete from public.ma_ediciones where id = p_edicion and not exists (select 1 from public.ma_edicion_items where edicion_id = p_edicion);
end $$;

-- Revierte una edición: deja los archivos como estaban antes de ella (solo administradora)
create or replace function public.ma_edicion_revertir(p_edicion bigint)
returns bigint language plpgsql security definer set search_path = public as $$
declare e public.ma_ediciones; it record; v_rev bigint; v_ahora jsonb;
begin
  if not public.ma_es_admin() then raise exception 'Sin permiso: solo la administradora puede revertir'; end if;
  select * into e from public.ma_ediciones where id = p_edicion;
  if e.id is null then raise exception 'La edición % no existe', p_edicion; end if;
  if e.revertida_por is not null then raise exception 'La edición % ya fue revertida', p_edicion; end if;
  if e.fin is null then raise exception 'La edición % todavía está abierta', p_edicion; end if;

  insert into public.ma_ediciones (carpeta_id, tipo, usuario, descripcion, anio, mes, revierte_a)
  values (e.carpeta_id, 'reversion', public.ma_email(), 'Reversión de la edición #' || p_edicion, e.anio, e.mes, p_edicion)
  returning id into v_rev;

  for it in select * from public.ma_edicion_items where edicion_id = p_edicion order by id desc loop
    select to_jsonb(a) - 'id' into v_ahora from public.ma_archivos a where a.carpeta_id = e.carpeta_id and a.ruta = it.ruta;
    if it.antes is null then
      -- el archivo se agregó en esa edición: se quita
      delete from public.ma_archivos where carpeta_id = e.carpeta_id and ruta = it.ruta;
      if v_ahora is not null then insert into public.ma_edicion_items (edicion_id, accion, ruta, antes, despues) values (v_rev, 'baja', it.ruta, v_ahora, null); end if;
    else
      -- el archivo cambió o se quitó: vuelve la versión anterior
      insert into public.ma_archivos (carpeta_id, ruta, nombre, anio, mes, tamano, modificado, storage, hash, sincronizado)
      values (e.carpeta_id, it.ruta, it.antes->>'nombre', it.antes->>'anio', it.antes->>'mes', (it.antes->>'tamano')::bigint,
              (it.antes->>'modificado')::timestamptz, it.antes->>'storage', it.antes->>'hash', now())
      on conflict (carpeta_id, ruta) do update set nombre = excluded.nombre, anio = excluded.anio, mes = excluded.mes,
        tamano = excluded.tamano, modificado = excluded.modificado, storage = excluded.storage, hash = excluded.hash, sincronizado = now();
      insert into public.ma_edicion_items (edicion_id, accion, ruta, antes, despues)
      values (v_rev, case when v_ahora is null then 'alta' else 'cambio' end, it.ruta, v_ahora, it.antes);
    end if;
  end loop;

  update public.ma_ediciones set fin = now(),
    nuevos    = (select count(*) from public.ma_edicion_items where edicion_id = v_rev and accion = 'alta'),
    cambiados = (select count(*) from public.ma_edicion_items where edicion_id = v_rev and accion = 'cambio'),
    quitados  = (select count(*) from public.ma_edicion_items where edicion_id = v_rev and accion = 'baja')
  where id = v_rev;
  update public.ma_ediciones set revertida_por = v_rev, revertida_en = now() where id = p_edicion;
  return v_rev;
end $$;

-- Quita un mes completo (año + mes) de la base; queda en el historial y se puede revertir (solo administradora)
create or replace function public.ma_quitar_mes(p_carpeta bigint, p_anio text, p_mes text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint; a record;
begin
  if not public.ma_es_admin() then raise exception 'Sin permiso: solo la administradora puede quitar meses'; end if;
  insert into public.ma_ediciones (carpeta_id, tipo, usuario, descripcion, anio, mes)
  values (p_carpeta, 'quitar_mes', public.ma_email(), 'Quitar ' || p_mes || ' ' || p_anio, p_anio, p_mes) returning id into v_id;
  for a in select * from public.ma_archivos where carpeta_id = p_carpeta and anio is not distinct from p_anio and mes is not distinct from p_mes loop
    insert into public.ma_edicion_items (edicion_id, accion, ruta, antes, despues) values (v_id, 'baja', a.ruta, to_jsonb(a) - 'id', null);
    delete from public.ma_archivos where id = a.id;
  end loop;
  update public.ma_ediciones set fin = now(), quitados = (select count(*) from public.ma_edicion_items where edicion_id = v_id) where id = v_id;
  return v_id;
end $$;

-- Permisos de un usuario (rol, módulos, activo). Crear la cuenta con contraseña lo hace la Edge Function.
create or replace function public.ma_usuario_guardar(p_email text, p_nombre text, p_rol text, p_activo boolean, p_modulos text[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.ma_es_admin() then raise exception 'Sin permiso: solo la administradora maneja usuarios'; end if;
  if lower(p_email) = public.ma_email() and (p_rol <> 'admin' or not p_activo) then
    raise exception 'No puedes quitarte a ti misma el rol de administradora ni desactivarte';
  end if;
  insert into public.ma_usuarios (email, nombre, rol, activo, modulos)
  values (lower(p_email), p_nombre, p_rol, coalesce(p_activo,true), coalesce(p_modulos,'{martina}'))
  on conflict (email) do update set nombre = excluded.nombre, rol = excluded.rol, activo = excluded.activo, modulos = excluded.modulos;
end $$;

-- ---------------------------------------------------------------------
-- 4) Seguridad: lectura con RLS, escritura solo por las funciones
-- ---------------------------------------------------------------------
alter table public.ma_carpetas      enable row level security;
alter table public.ma_archivos      enable row level security;
alter table public.ma_usuarios      enable row level security;
alter table public.ma_ediciones     enable row level security;
alter table public.ma_edicion_items enable row level security;

grant usage on schema public to authenticated;
revoke insert, update, delete on public.ma_carpetas, public.ma_archivos, public.ma_usuarios, public.ma_ediciones, public.ma_edicion_items from anon, authenticated;
revoke all on public.ma_carpetas, public.ma_archivos, public.ma_usuarios, public.ma_ediciones, public.ma_edicion_items from anon;
grant select on public.ma_carpetas, public.ma_archivos, public.ma_usuarios, public.ma_ediciones, public.ma_edicion_items to authenticated;

drop policy if exists "ma_carpetas_leer"   on public.ma_carpetas;
drop policy if exists "ma_archivos_leer"   on public.ma_archivos;
drop policy if exists "ma_archivos_editar" on public.ma_archivos;
drop policy if exists "ma_usuarios_propio" on public.ma_usuarios;
drop policy if exists "ma_usuarios_leer"   on public.ma_usuarios;
drop policy if exists "ma_ediciones_leer"  on public.ma_ediciones;
drop policy if exists "ma_items_leer"      on public.ma_edicion_items;

create policy "ma_carpetas_leer"  on public.ma_carpetas      for select to authenticated using (public.ma_es_usuario());
create policy "ma_archivos_leer"  on public.ma_archivos      for select to authenticated using (public.ma_es_usuario());
-- cada quien ve su propia fila; la administradora ve a todos
create policy "ma_usuarios_leer"  on public.ma_usuarios      for select to authenticated using (lower(email) = public.ma_email() or public.ma_es_admin());
-- el historial lo ven la administradora y los editores
create policy "ma_ediciones_leer" on public.ma_ediciones     for select to authenticated using (public.ma_es_editor());
create policy "ma_items_leer"     on public.ma_edicion_items for select to authenticated using (public.ma_es_editor());

-- Tabla vieja de la versión anterior (si existe): solo lectura
do $$ begin
  if to_regclass('public.ma_sync_log') is not null then
    execute 'revoke insert, update, delete on public.ma_sync_log from anon, authenticated';
    execute 'drop policy if exists "ma_sync_log_insertar" on public.ma_sync_log';
    execute 'drop policy if exists "ma_sync_log_actualizar" on public.ma_sync_log';
  end if;
end $$;

grant execute on function public.ma_email(), public.ma_rol(), public.ma_es_usuario(), public.ma_es_editor(), public.ma_es_admin() to authenticated;
grant execute on function public.ma_edicion_iniciar(bigint, text, text, text)  to authenticated;
grant execute on function public.ma_edicion_aplicar(bigint, text, jsonb)       to authenticated;
grant execute on function public.ma_edicion_cerrar(bigint)                     to authenticated;
grant execute on function public.ma_edicion_revertir(bigint)                   to authenticated;
grant execute on function public.ma_quitar_mes(bigint, text, text)             to authenticated;
grant execute on function public.ma_usuario_guardar(text, text, text, boolean, text[]) to authenticated;
revoke execute on function public.ma_edicion_iniciar(bigint, text, text, text), public.ma_edicion_aplicar(bigint, text, jsonb),
  public.ma_edicion_cerrar(bigint), public.ma_edicion_revertir(bigint), public.ma_quitar_mes(bigint, text, text),
  public.ma_usuario_guardar(text, text, text, boolean, text[]) from anon, public;

-- Storage: leer = usuarios registrados; subir = editor/admin; nadie borra (las versiones se guardan para poder revertir)
drop policy if exists "reportes_leer"       on storage.objects;
drop policy if exists "reportes_subir"      on storage.objects;
drop policy if exists "reportes_actualizar" on storage.objects;
drop policy if exists "reportes_borrar"     on storage.objects;
create policy "reportes_leer"  on storage.objects for select to authenticated using (bucket_id = 'reportes' and public.ma_es_usuario());
create policy "reportes_subir" on storage.objects for insert to authenticated with check (bucket_id = 'reportes' and public.ma_es_editor());

-- ---------------------------------------------------------------------
-- 5) Datos iniciales — EDITAR si hace falta
-- ---------------------------------------------------------------------
insert into public.ma_carpetas (modulo, nombre, ruta, cuenta)
values ('martina', 'Pantera Reportería — Martina', '/PruebaDashboard', 'jromero@rapiprestamos.net')
on conflict (modulo, ruta) do nothing;

-- Primera administradora (las demás cuentas se crean desde el dashboard, pestaña Usuarios)
insert into public.ma_usuarios (email, nombre, rol, activo) values ('jromero@rapiprestamos.net', null, 'admin', true)
on conflict (email) do update set rol = 'admin', activo = true;
