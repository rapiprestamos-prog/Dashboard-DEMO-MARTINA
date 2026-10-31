-- =====================================================================
-- PANTERA REPORTERÍA — HISTORIAL DE CARGAS
-- Proyecto: https://oiongsqkcbovzsavjwql.supabase.co
-- Se corre UNA vez: Supabase → SQL Editor → New query → pegar todo → Run.
-- Se puede correr más de una vez: no borra datos.
-- Necesita que ya esté corrido BASE_DE_DATOS_FINAL.sql (usa ma_email, ma_tiene_modulo y ma_es_admin).
--
-- Qué guarda: cada vez que cambian los Excel de la carpeta PruebaDashboard, quién lo detectó,
-- cuándo, qué archivos entraron / cambiaron / salieron y una copia comprimida de los datos
-- del reporte (para "Ver esta versión"). Los Excel siguen en OneDrive; esto no los modifica.
-- =====================================================================

create table if not exists public.ma_pantera_cargas (
  id           bigint generated always as identity primary key,
  creado_en    timestamptz not null default now(),
  usuario      text not null default public.ma_email(),   -- quién abrió el dashboard y detectó el cambio
  firma        text not null,                              -- huella de la carpeta (archivo + fecha + tamaño)
  archivos     jsonb not null default '[]'::jsonb,         -- [{ruta, mod, size}]
  cambios      jsonb not null default '{}'::jsonb,         -- {nuevos:[], cambiados:[], quitados:[], primera}
  resumen      jsonb,                                      -- archivos reconocidos y meses con balance
  datos        text,                                       -- copia de los datos del reporte (gzip + base64)
  tiene_datos  boolean generated always as (datos is not null) stored
);
create index if not exists ma_pantera_cargas_fecha on public.ma_pantera_cargas (creado_en desc);

alter table public.ma_pantera_cargas enable row level security;
grant select, insert, delete on public.ma_pantera_cargas to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant select, insert, update, delete on public.ma_pantera_cargas to service_role;

-- Quién puede qué (mismo criterio que el resto del dashboard):
--  · ver el historial: quien tiene el módulo "Pantera Reportería — Martina" (la administradora, siempre)
--  · registrar una carga: quien tiene el módulo, y solo a su nombre
--  · borrar registros: solo la administradora
drop policy if exists ma_pantera_cargas_leer   on public.ma_pantera_cargas;
drop policy if exists ma_pantera_cargas_crear  on public.ma_pantera_cargas;
drop policy if exists ma_pantera_cargas_borrar on public.ma_pantera_cargas;
create policy ma_pantera_cargas_leer   on public.ma_pantera_cargas for select to authenticated
  using (public.ma_tiene_modulo('martina'));
create policy ma_pantera_cargas_crear  on public.ma_pantera_cargas for insert to authenticated
  with check (public.ma_tiene_modulo('martina') and lower(usuario) = public.ma_email());
create policy ma_pantera_cargas_borrar on public.ma_pantera_cargas for delete to authenticated
  using (public.ma_es_admin());
