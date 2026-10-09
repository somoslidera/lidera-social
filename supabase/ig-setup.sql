-- Lidera Social: schema do app de Instagram (projeto flow, fvcbxorfstqqeewocxkf)
-- Rodar via Management API ou SQL Editor. Idempotente.
-- Tudo com prefixo ig_. Acesso: admin do Flow (eh_admin) OU e-mail na tabela ig_acesso.

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------- acesso ----------
create table if not exists public.ig_acesso (
  email text primary key,
  nome text,
  papel text default 'sdr',          -- admin | closer | sdr
  criado_em timestamptz default now()
);

create or replace function public.ig_acesso() returns boolean
language sql stable security definer set search_path = public as $$
  select public.eh_admin()
      or exists (select 1 from public.ig_acesso a where lower(a.email) = lower(coalesce(auth.jwt()->>'email','')));
$$;

-- ---------- contas conectadas ----------
create table if not exists public.ig_contas (
  id text primary key,                 -- ig user id (1784...)
  username text not null,
  nome text,
  foto text,
  biografia text,
  seguidores int default 0,
  seguindo int default 0,
  midias int default 0,
  ativo boolean default true,
  conectado_em timestamptz default now(),
  token_expira timestamptz,
  ultimo_sync timestamptz,
  erro_sync text,
  webhook_ok boolean default false,
  config jsonb default '{}'::jsonb      -- estratégia por conta (rampa, calendário de story, metas, dono)
);

-- tokens separados: sem policy = só service_role lê
create table if not exists public.ig_tokens (
  conta_id text primary key references public.ig_contas(id) on delete cascade,
  access_token text not null,
  expira_em timestamptz,
  permissoes text[],
  atualizado_em timestamptz default now()
);

-- ---------- métricas ----------
create table if not exists public.ig_snapshots (
  conta_id text references public.ig_contas(id) on delete cascade,
  data date not null,
  seguidores int, seguindo int, midias int,
  novos_seguidores int,                 -- follower_count do dia (API) ou delta
  alcance int, visitas_perfil int, cliques_site int, contas_engajadas int,
  insights jsonb default '{}'::jsonb,
  primary key (conta_id, data)
);

create table if not exists public.ig_midias (
  id text primary key,
  conta_id text references public.ig_contas(id) on delete cascade,
  tipo text,                            -- IMAGE | VIDEO | CAROUSEL_ALBUM | REELS
  produto text,                         -- FEED | REELS | STORY
  legenda text,
  url text, thumb text, permalink text,
  publicado_em timestamptz,
  curtidas int default 0, comentarios int default 0,
  alcance int, salvos int, compartilhamentos int, visualizacoes int, interacoes int,
  insights jsonb default '{}'::jsonb,
  categoria text,                       -- motor 3x2: dor | bastidor | ensino | convite | resultado
  atualizado_em timestamptz default now()
);
create index if not exists ig_midias_conta_data on public.ig_midias(conta_id, publicado_em desc);

-- ---------- leads (pipeline do playbook) ----------
create table if not exists public.ig_leads (
  id uuid primary key default gen_random_uuid(),
  conta_id text references public.ig_contas(id) on delete cascade,
  ig_user_id text,                      -- IGSID quando vem de DM/comentário
  username text not null,
  nome text,
  restaurante text,
  cidade text,
  segmento text,
  faixa text,                           -- 'ate100' | '100a300' | '300a500' | 'acima500'
  fluxo text default 'NS',              -- SC | RS | CP | NS | VS | OB
  etapa text default 'novo',            -- novo | aquecendo | ativado | rmv | desafio | escada | convite | agendado_charles | agendado_guilherme | compareceu | noshow | frio | fora_icp
  icp text default 'indefinido',        -- passa | nao_passa | indefinido
  sinal_calor text,
  conexao text,                         -- o detalhe específico do perfil (linha 2 da mensagem)
  desafio text,                         -- nas palavras dele (literal)
  ganho text,                           -- degrau 4, literal
  whatsapp text, email text,
  perfil jsonb default '{}'::jsonb,     -- business_discovery
  pesquisa text,                        -- notas da pesquisa profunda
  ultimo_toque timestamptz,
  proximo_toque date,
  toques int default 0,
  aquecimento_dia int default 0,        -- 0,1,2 (outbound)
  aquecido_em date,
  versao_msg text,                      -- A | B (teste A/B da boas-vindas)
  leadforge_id text,
  conversa_id text,
  responsavel text,
  criado_por text,
  criado_em timestamptz default now(),
  atualizado_em timestamptz default now(),
  unique (conta_id, username)
);
create index if not exists ig_leads_etapa on public.ig_leads(conta_id, etapa);
create index if not exists ig_leads_prox on public.ig_leads(conta_id, proximo_toque);

-- ---------- comentários ----------
create table if not exists public.ig_comentarios (
  id text primary key,
  conta_id text references public.ig_contas(id) on delete cascade,
  midia_id text,
  parent_id text,
  autor_id text, autor_username text,
  texto text,
  criado_em timestamptz,
  de_mim boolean default false,
  respondido boolean default false,
  resposta_texto text,
  oculto boolean default false,
  lead_id uuid references public.ig_leads(id) on delete set null,
  sugestao_ia text,
  lido boolean default false
);
create index if not exists ig_com_conta on public.ig_comentarios(conta_id, criado_em desc);

-- ---------- mensagens ----------
create table if not exists public.ig_conversas (
  id text primary key,                  -- conversation id ou 'ig:'||participante_id
  conta_id text references public.ig_contas(id) on delete cascade,
  participante_id text,
  participante_username text,
  participante_nome text,
  participante_foto text,
  ultima_msg text,
  ultima_em timestamptz,
  ultima_de_mim boolean,
  nao_lidas int default 0,
  lead_id uuid references public.ig_leads(id) on delete set null,
  camada int default 1,                 -- camada atual da conversa (1..4)
  arquivada boolean default false,
  atualizado_em timestamptz default now()
);
create index if not exists ig_conv_conta on public.ig_conversas(conta_id, ultima_em desc);

create table if not exists public.ig_mensagens (
  id text primary key,                  -- mid
  conversa_id text references public.ig_conversas(id) on delete cascade,
  conta_id text,
  de_mim boolean default false,
  texto text,
  tipo text default 'texto',            -- texto | story_reply | story_mention | reaction | anexo | share
  anexos jsonb default '[]'::jsonb,
  criado_em timestamptz,
  lido boolean default false
);
create index if not exists ig_msg_conv on public.ig_mensagens(conversa_id, criado_em);

-- ---------- fila de ações (modo assistido) ----------
create table if not exists public.ig_acoes (
  id uuid primary key default gen_random_uuid(),
  conta_id text references public.ig_contas(id) on delete cascade,
  lead_id uuid references public.ig_leads(id) on delete cascade,
  conversa_id text,
  comentario_id text,
  data date not null default current_date,
  bloco int default 5,                  -- ordem da rotina diária (1 story, 2 inbound, 3 conversas, 4 NS, 5 follow-up, 6 story 2, 7 VS, 8 OB, 9 fechamento)
  tipo text not null,                   -- story_captura | responder_dm | responder_comentario | seguir | curtir | ver_stories | reagir_story | comentar | ativar | followup | triagem | pesquisa | visita | registrar
  titulo text,
  texto text,                           -- mensagem sugerida
  url text,                             -- deep link (perfil, stories, direct)
  status text default 'pendente',       -- pendente | feita | pulada
  feita_em timestamptz,
  feita_por text,
  origem text,                          -- regra que gerou
  criado_em timestamptz default now()
);
create index if not exists ig_acoes_dia on public.ig_acoes(conta_id, data, status);

-- ---------- log ----------
create table if not exists public.ig_log (
  id bigserial primary key,
  quando timestamptz default now(),
  tipo text,                            -- webhook | sync | erro | acao
  conta_id text,
  detalhe jsonb
);

-- ---------- RLS ----------
alter table public.ig_acesso enable row level security;
alter table public.ig_contas enable row level security;
alter table public.ig_tokens enable row level security;
alter table public.ig_snapshots enable row level security;
alter table public.ig_midias enable row level security;
alter table public.ig_leads enable row level security;
alter table public.ig_comentarios enable row level security;
alter table public.ig_conversas enable row level security;
alter table public.ig_mensagens enable row level security;
alter table public.ig_acoes enable row level security;
alter table public.ig_log enable row level security;

do $$
declare t text;
begin
  foreach t in array array['ig_contas','ig_snapshots','ig_midias','ig_leads','ig_comentarios','ig_conversas','ig_mensagens','ig_acoes','ig_log'] loop
    execute format('drop policy if exists %I_acesso on public.%I', t, t);
    execute format('create policy %I_acesso on public.%I for all using (public.ig_acesso()) with check (public.ig_acesso())', t, t);
  end loop;
end $$;
drop policy if exists ig_acesso_admin on public.ig_acesso;
create policy ig_acesso_admin on public.ig_acesso for all using (public.eh_admin()) with check (public.eh_admin());
drop policy if exists ig_acesso_leitura on public.ig_acesso;
create policy ig_acesso_leitura on public.ig_acesso for select using (public.ig_acesso());
-- ig_tokens: sem policy (só service_role)

-- atualizado_em automático
create or replace function public.ig_touch() returns trigger language plpgsql as $$
begin new.atualizado_em = now(); return new; end $$;
drop trigger if exists ig_leads_touch on public.ig_leads;
create trigger ig_leads_touch before update on public.ig_leads for each row execute function public.ig_touch();
drop trigger if exists ig_conversas_touch on public.ig_conversas;
create trigger ig_conversas_touch before update on public.ig_conversas for each row execute function public.ig_touch();

-- realtime para inbox/comentários
do $$ begin
  alter publication supabase_realtime add table public.ig_mensagens;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ig_comentarios;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.ig_conversas;
exception when duplicate_object then null; end $$;

-- acesso inicial
insert into public.ig_acesso(email,nome,papel) values ('contato@somoslidera.com.br','Guilherme','admin')
on conflict (email) do nothing;
