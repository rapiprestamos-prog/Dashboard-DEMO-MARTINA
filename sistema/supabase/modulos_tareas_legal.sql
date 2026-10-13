-- =====================================================================
--  M&A Capital · Dashboard Interno Ultimate
--  Módulos "Seguimiento de tareas" y "Agente Legal" + jerarquía de usuarios
--
--  Correr DESPUÉS de pantera_supabase.sql:  Supabase → SQL Editor → pegar → Run.
--  Se puede correr más de una vez (no borra datos).
--
--  Módulos (se marcan por usuario en el botón Usuarios del inicio):
--    tareas        → Seguimiento de tareas
--    agente_legal  → Agente Legal
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1) Jerarquía: cargo y jefe de cada usuario
-- ---------------------------------------------------------------------
alter table public.ma_usuarios add column if not exists cargo text;
alter table public.ma_usuarios add column if not exists jefe  text;   -- correo del jefe directo

-- Todos los que están por debajo de una persona (directos e indirectos)
create or replace function public.ma_subordinados(p_email text) returns setof text
language sql stable security definer set search_path = public as $$
  with recursive s(email) as (
    select u.email from public.ma_usuarios u where lower(u.jefe) = lower(p_email)
    union
    select u.email from public.ma_usuarios u join s on lower(u.jefe) = lower(s.email)
  ) select lower(email) from s
$$;

-- Directorio de personas activas (para asignar responsables y ver el organigrama)
create or replace function public.ma_directorio()
returns table(email text, nombre text, cargo text, jefe text, rol text)
language sql stable security definer set search_path = public as $$
  select lower(u.email), u.nombre, u.cargo, lower(u.jefe), u.rol
  from public.ma_usuarios u
  where u.activo and public.ma_es_usuario()
  order by coalesce(u.nombre, u.email)
$$;

-- Cargo y jefe (solo administradora; no permite ciclos)
create or replace function public.ma_jerarquia_guardar(p_email text, p_cargo text, p_jefe text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.ma_es_admin() then raise exception 'Sin permiso: solo la administradora maneja la jerarquía'; end if;
  if p_jefe is not null and p_jefe <> '' then
    if lower(p_jefe) = lower(p_email) then raise exception 'Una persona no puede ser su propio jefe'; end if;
    if lower(p_jefe) in (select * from public.ma_subordinados(p_email)) then
      raise exception 'No se puede: % está por debajo de % en la jerarquía', p_jefe, p_email;
    end if;
  end if;
  update public.ma_usuarios set cargo = nullif(trim(p_cargo),''), jefe = nullif(lower(trim(p_jefe)),'')
  where lower(email) = lower(p_email);
end $$;

-- ---------------------------------------------------------------------
-- 2) Seguimiento de tareas
-- ---------------------------------------------------------------------
create table if not exists public.ta_carpetas (
  id          bigint generated always as identity primary key,
  nombre      text not null,
  tipo        text not null default 'Proyecto' check (tipo in ('Empresa','Proyecto','Área')),
  padre_id    bigint references public.ta_carpetas(id) on delete cascade,
  color       text,
  creado      timestamptz not null default now(),
  creado_por  text not null default public.ma_email()
);

create table if not exists public.ta_tareas (
  id               bigint generated always as identity primary key,
  carpeta_id       bigint references public.ta_carpetas(id) on delete set null,
  titulo           text not null,
  descripcion      text,
  prioridad        text not null default 'Media' check (prioridad in ('Crítica','Alta','Media','Baja')),
  estado           text not null default 'Pendiente' check (estado in ('Pendiente','En progreso','Esperando respuesta','Completada')),
  responsable      text,
  fecha_tentativa  date,
  fecha_real       date,
  creado           timestamptz not null default now(),
  creado_por       text not null default public.ma_email(),
  actualizado      timestamptz not null default now()
);
create index if not exists ta_tareas_carpeta_idx on public.ta_tareas(carpeta_id);
create index if not exists ta_tareas_fecha_idx   on public.ta_tareas(fecha_tentativa);

create table if not exists public.ta_avances (
  id              bigint generated always as identity primary key,
  tarea_id        bigint not null references public.ta_tareas(id) on delete cascade,
  nota            text,
  archivo_path    text,
  archivo_nombre  text,
  usuario         text not null default public.ma_email(),
  creado          timestamptz not null default now()
);

create table if not exists public.ta_comentarios (
  id        bigint generated always as identity primary key,
  tarea_id  bigint not null references public.ta_tareas(id) on delete cascade,
  texto     text not null,
  usuario   text not null default public.ma_email(),
  creado    timestamptz not null default now()
);

create table if not exists public.ta_historial (
  id        bigint generated always as identity primary key,
  tarea_id  bigint not null references public.ta_tareas(id) on delete cascade,
  usuario   text,
  detalle   text not null,
  creado    timestamptz not null default now()
);
create index if not exists ta_historial_tarea_idx on public.ta_historial(tarea_id, creado);

-- Historial automático de cada tarea
create or replace function public.ta_tareas_historial() returns trigger
language plpgsql security definer set search_path = public as $$
declare d text[] := '{}'; f text;
begin
  if tg_op = 'INSERT' then
    insert into public.ta_historial (tarea_id, usuario, detalle) values (new.id, public.ma_email(), 'Creó la tarea');
    return new;
  end if;
  new.actualizado := now();
  if new.titulo is distinct from old.titulo then d := d || ('Título: «' || coalesce(old.titulo,'') || '» → «' || coalesce(new.titulo,'') || '»'); end if;
  if new.estado is distinct from old.estado then d := d || ('Estado: ' || old.estado || ' → ' || new.estado); end if;
  if new.prioridad is distinct from old.prioridad then d := d || ('Prioridad: ' || old.prioridad || ' → ' || new.prioridad); end if;
  if new.responsable is distinct from old.responsable then d := d || ('Responsable: ' || coalesce(old.responsable,'—') || ' → ' || coalesce(new.responsable,'—')); end if;
  if new.fecha_tentativa is distinct from old.fecha_tentativa then d := d || ('Fecha tentativa: ' || coalesce(old.fecha_tentativa::text,'—') || ' → ' || coalesce(new.fecha_tentativa::text,'—')); end if;
  if new.fecha_real is distinct from old.fecha_real then d := d || ('Fecha real: ' || coalesce(old.fecha_real::text,'—') || ' → ' || coalesce(new.fecha_real::text,'—')); end if;
  if new.carpeta_id is distinct from old.carpeta_id then d := d || 'Cambió de carpeta'::text; end if;
  if new.descripcion is distinct from old.descripcion then d := d || 'Editó la descripción'::text; end if;
  foreach f in array d loop
    insert into public.ta_historial (tarea_id, usuario, detalle) values (new.id, public.ma_email(), f);
  end loop;
  return new;
end $$;
drop trigger if exists ta_tareas_historial_trg on public.ta_tareas;
create trigger ta_tareas_historial_trg before update on public.ta_tareas for each row execute function public.ta_tareas_historial();
drop trigger if exists ta_tareas_historial_ins on public.ta_tareas;
create trigger ta_tareas_historial_ins after insert on public.ta_tareas for each row execute function public.ta_tareas_historial();

-- ¿Puede ver/editar esta tarea? Administradora: todas. Los demás: las suyas, las que crearon
-- y las de las personas que tienen por debajo en la jerarquía.
create or replace function public.ta_puede(p_responsable text, p_creado_por text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.ma_tiene_modulo('tareas') and (
    public.ma_es_admin()
    or lower(coalesce(p_responsable,'')) = public.ma_email()
    or lower(coalesce(p_creado_por,''))  = public.ma_email()
    or lower(coalesce(p_responsable,'')) in (select * from public.ma_subordinados(public.ma_email()))
  )
$$;

-- Archivos de avances (bucket privado)
insert into storage.buckets (id, name, public) values ('tareas','tareas', false) on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 3) Agente Legal (los documentos se leen de la carpeta Legal de OneDrive;
--    aquí solo se guardan datos del caso, checklists y resultados)
-- ---------------------------------------------------------------------
create table if not exists public.lg_casos (
  caso             text primary key,          -- nombre de la subcarpeta del caso
  sociedad         text,
  tipo_proceso     text,
  actualizado      timestamptz not null default now(),
  actualizado_por  text not null default public.ma_email()
);

create table if not exists public.lg_checklists (
  tipo_proceso     text primary key,
  items            jsonb not null default '[]',   -- [{"documento": "...", "detalle": "..."}]
  actualizado      timestamptz not null default now(),
  actualizado_por  text not null default public.ma_email()
);

create table if not exists public.lg_resultados (
  id          bigint generated always as identity primary key,
  caso        text not null,
  herramienta text not null,                     -- due_diligence | cierre | semaforo
  resultado   jsonb not null,
  usuario     text not null default public.ma_email(),
  creado      timestamptz not null default now()
);
create index if not exists lg_resultados_idx on public.lg_resultados(caso, herramienta, creado desc);

-- ---------------------------------------------------------------------
-- 4) Seguridad
-- ---------------------------------------------------------------------
alter table public.ta_carpetas    enable row level security;
alter table public.ta_tareas      enable row level security;
alter table public.ta_avances     enable row level security;
alter table public.ta_comentarios enable row level security;
alter table public.ta_historial   enable row level security;
alter table public.lg_casos       enable row level security;
alter table public.lg_checklists  enable row level security;
alter table public.lg_resultados  enable row level security;

revoke all on public.ta_carpetas, public.ta_tareas, public.ta_avances, public.ta_comentarios, public.ta_historial,
  public.lg_casos, public.lg_checklists, public.lg_resultados from anon;
grant select, insert, update, delete on public.ta_carpetas, public.ta_tareas, public.ta_avances, public.ta_comentarios,
  public.lg_casos, public.lg_checklists, public.lg_resultados to authenticated;
grant select on public.ta_historial to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select, insert, update, delete on public.ta_carpetas, public.ta_tareas, public.ta_avances, public.ta_comentarios, public.ta_historial,
  public.lg_casos, public.lg_checklists, public.lg_resultados to service_role;

drop policy if exists ta_carpetas_leer  on public.ta_carpetas;
drop policy if exists ta_carpetas_crear on public.ta_carpetas;
drop policy if exists ta_carpetas_editar on public.ta_carpetas;
drop policy if exists ta_carpetas_borrar on public.ta_carpetas;
create policy ta_carpetas_leer   on public.ta_carpetas for select to authenticated using (public.ma_tiene_modulo('tareas'));
create policy ta_carpetas_crear  on public.ta_carpetas for insert to authenticated with check (public.ma_tiene_modulo('tareas'));
create policy ta_carpetas_editar on public.ta_carpetas for update to authenticated using (public.ma_tiene_modulo('tareas')) with check (public.ma_tiene_modulo('tareas'));
create policy ta_carpetas_borrar on public.ta_carpetas for delete to authenticated using (public.ma_es_admin() or lower(creado_por) = public.ma_email());

drop policy if exists ta_tareas_leer   on public.ta_tareas;
drop policy if exists ta_tareas_crear  on public.ta_tareas;
drop policy if exists ta_tareas_editar on public.ta_tareas;
drop policy if exists ta_tareas_borrar on public.ta_tareas;
create policy ta_tareas_leer   on public.ta_tareas for select to authenticated using (public.ta_puede(responsable, creado_por));
create policy ta_tareas_crear  on public.ta_tareas for insert to authenticated with check (public.ma_tiene_modulo('tareas') and lower(creado_por) = public.ma_email());
create policy ta_tareas_editar on public.ta_tareas for update to authenticated using (public.ta_puede(responsable, creado_por)) with check (public.ma_tiene_modulo('tareas'));
create policy ta_tareas_borrar on public.ta_tareas for delete to authenticated using (public.ma_es_admin() or lower(creado_por) = public.ma_email());

drop policy if exists ta_avances_leer  on public.ta_avances;
drop policy if exists ta_avances_crear on public.ta_avances;
drop policy if exists ta_avances_borrar on public.ta_avances;
create policy ta_avances_leer   on public.ta_avances for select to authenticated using (exists (select 1 from public.ta_tareas t where t.id = tarea_id));
create policy ta_avances_crear  on public.ta_avances for insert to authenticated with check (lower(usuario) = public.ma_email() and exists (select 1 from public.ta_tareas t where t.id = tarea_id));
create policy ta_avances_borrar on public.ta_avances for delete to authenticated using (public.ma_es_admin() or lower(usuario) = public.ma_email());

drop policy if exists ta_coment_leer  on public.ta_comentarios;
drop policy if exists ta_coment_crear on public.ta_comentarios;
drop policy if exists ta_coment_borrar on public.ta_comentarios;
create policy ta_coment_leer   on public.ta_comentarios for select to authenticated using (exists (select 1 from public.ta_tareas t where t.id = tarea_id));
create policy ta_coment_crear  on public.ta_comentarios for insert to authenticated with check (lower(usuario) = public.ma_email() and exists (select 1 from public.ta_tareas t where t.id = tarea_id));
create policy ta_coment_borrar on public.ta_comentarios for delete to authenticated using (public.ma_es_admin() or lower(usuario) = public.ma_email());

drop policy if exists ta_hist_leer on public.ta_historial;
create policy ta_hist_leer on public.ta_historial for select to authenticated using (exists (select 1 from public.ta_tareas t where t.id = tarea_id));

drop policy if exists lg_casos_todo on public.lg_casos;
drop policy if exists lg_check_todo on public.lg_checklists;
drop policy if exists lg_res_leer  on public.lg_resultados;
drop policy if exists lg_res_crear on public.lg_resultados;
create policy lg_casos_todo on public.lg_casos      for all to authenticated using (public.ma_tiene_modulo('agente_legal')) with check (public.ma_tiene_modulo('agente_legal'));
create policy lg_check_todo on public.lg_checklists for all to authenticated using (public.ma_tiene_modulo('agente_legal')) with check (public.ma_tiene_modulo('agente_legal'));
create policy lg_res_leer   on public.lg_resultados for select to authenticated using (public.ma_tiene_modulo('agente_legal'));
create policy lg_res_crear  on public.lg_resultados for insert to authenticated with check (public.ma_tiene_modulo('agente_legal') and lower(usuario) = public.ma_email());

-- Archivos de avances: carpeta = id de la tarea
drop policy if exists tareas_arch_leer  on storage.objects;
drop policy if exists tareas_arch_subir on storage.objects;
create policy tareas_arch_leer on storage.objects for select to authenticated
  using (bucket_id = 'tareas' and split_part(name,'/',1) ~ '^[0-9]+$'
         and exists (select 1 from public.ta_tareas t where t.id = split_part(name,'/',1)::bigint));
create policy tareas_arch_subir on storage.objects for insert to authenticated
  with check (bucket_id = 'tareas' and split_part(name,'/',1) ~ '^[0-9]+$'
         and exists (select 1 from public.ta_tareas t where t.id = split_part(name,'/',1)::bigint));

grant execute on function public.ma_subordinados(text), public.ma_directorio(), public.ma_jerarquia_guardar(text, text, text),
  public.ta_puede(text, text) to authenticated;
revoke execute on function public.ma_jerarquia_guardar(text, text, text) from anon, public;
