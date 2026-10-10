// Edge Function: ig-api (Lidera Social)
// Rotas (todas POST com JSON; auth = JWT do usuário com acesso OU header x-cron = IG_CRON_SECRET):
//   /sync            {conta_id?, completo?}   perfil, mídias+insights, snapshot do dia, comentários, conversas
//   /fila/gerar      {conta_id, data?}        monta a fila do dia (rotina do playbook)
//   /comentario/responder {id, texto}  /comentario/ocultar {id, ocultar}
//   /dm/enviar       {conversa_id, texto}
//   /lead/pesquisar  {conta_id, username}      business_discovery + IA (triagem ICP, conexão, boas-vindas)
//   /ia/sugerir      {tipo:'dm'|'comentario', id}
//   /ia/classificar_midias {conta_id}          categoriza posts no motor 3x2
// Deploy: supabase functions deploy ig-api --project-ref fvcbxorfstqqeewocxkf --use-api --no-verify-jwt
import { admin, CORS, CRON_SECRET, gemini, graph, graphPost, hoje, json, log, saudacao, SUPABASE_URL, tokenDaConta, usuarioAutorizado } from "../_shared/ig.ts";
import { CADENCIA, ETAPAS, limiteDiario, PLAYBOOK_IA, STORY_CAPTURA } from "../_shared/playbook.ts";

type Row = Record<string, unknown>;
const db = admin();

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.split("/ig-api")[1] || "/";
  if (rota === "/" || rota === "") return json({ ok: true, app: "Lidera Social", rotas: ["/sync", "/fila/gerar", "/comentario/responder", "/comentario/ocultar", "/dm/enviar", "/lead/pesquisar", "/ia/sugerir", "/ia/classificar_midias"] });

  const cron = req.headers.get("x-cron") === CRON_SECRET && !!CRON_SECRET;
  const user = cron ? { email: "cron", id: "cron" } : await usuarioAutorizado(req);
  if (!user) return json({ erro: "não autorizado" }, 401);
  const body: Row = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  try {
    switch (rota) {
      case "/sync": return json(await sync(body, user.email));
      case "/fila/gerar": return json(await gerarFila(String(body.conta_id), String(body.data || hoje())));
      case "/comentario/responder": return json(await responderComentario(String(body.id), String(body.texto), user.email));
      case "/comentario/ocultar": return json(await ocultarComentario(String(body.id), body.ocultar !== false));
      case "/dm/enviar": return json(await enviarDM(String(body.conversa_id), String(body.texto), user.email));
      case "/lead/pesquisar": return json(await pesquisarLead(String(body.conta_id), String(body.username), user.email, body));
      case "/ia/sugerir": return json(await sugerir(String(body.tipo), String(body.id)));
      case "/ia/classificar_midias": return json(await classificarMidias(String(body.conta_id)));
      case "/ia/conteudo": return json(await criarConteudo(body));
      case "/publicar": return json(await publicar(body, user.email));
      default: return json({ erro: "rota desconhecida" }, 404);
    }
  } catch (e) {
    await log("erro", (body.conta_id as string) || null, { rota, erro: String(e) });
    return json({ erro: String(e) }, 500);
  }
});

// ======================= SYNC =======================
async function sync(body: Row, quem: string) {
  const ids = body.conta_id ? [String(body.conta_id)] : ((await db.from("ig_contas").select("id").eq("ativo", true)).data || []).map((c) => c.id as string);
  const out: Row = {};
  for (const id of ids) {
    try {
      const tok = await tokenDaConta(id);
      if (!tok) { out[id] = "sem token"; continue; }
      const r: Row = {};
      // perfil
      const me = await graph("me", tok, { fields: "username,name,profile_picture_url,followers_count,follows_count,media_count,biography" });
      await db.from("ig_contas").update({ username: me.username, nome: me.name, foto: me.profile_picture_url, biografia: me.biography, seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count, ultimo_sync: new Date().toISOString(), erro_sync: null }).eq("id", id);
      // snapshot do dia (insights da conta)
      r.snapshot = await snapshotConta(id, tok, me);
      // mídias
      r.midias = await syncMidias(id, tok, body.completo === true);
      // comentários das últimas mídias
      r.comentarios = await syncComentarios(id, tok);
      // conversas
      r.conversas = await syncConversas(id, tok, body.completo === true);
      // token a vencer em < 10 dias: renova
      const { data: t } = await db.from("ig_tokens").select("expira_em").eq("conta_id", id).maybeSingle();
      if (t?.expira_em && new Date(t.expira_em).getTime() - Date.now() < 10 * 864e5) {
        await fetch(`${SUPABASE_URL}/functions/v1/ig-auth/refresh`, { method: "POST", headers: { "x-cron": CRON_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ conta_id: id }) }).catch(() => {});
        r.token = "renovado";
      }
      out[id] = r;
      await log("sync", id, { por: quem, ...r });
    } catch (e) {
      out[id] = String(e);
      await db.from("ig_contas").update({ erro_sync: String(e).slice(0, 300), ultimo_sync: new Date().toISOString() }).eq("id", id);
      await log("erro", id, { onde: "sync", erro: String(e) });
    }
  }
  return out;
}

async function snapshotConta(id: string, tok: string, me: Row) {
  const data = hoje();
  const ins: Row = {};
  const pega = async (metric: string, extra: Record<string, string>) => {
    try {
      const j = await graph(`${id}/insights`, tok, { metric, period: "day", ...extra });
      for (const m of j.data || []) {
        const v = m.total_value?.value ?? m.values?.[m.values.length - 1]?.value;
        ins[m.name] = v;
      }
    } catch (e) { ins[`erro_${metric.split(",")[0]}`] = String(e).slice(0, 120); }
  };
  await pega("reach,profile_views,website_clicks,accounts_engaged,total_interactions", { metric_type: "total_value" });
  await pega("follower_count", {});
  // ontem, para calcular novos seguidores quando follower_count não vier
  const { data: ontem } = await db.from("ig_snapshots").select("seguidores").eq("conta_id", id).lt("data", data).order("data", { ascending: false }).limit(1).maybeSingle();
  const novos = ins.follower_count ?? (ontem ? Number(me.followers_count) - Number(ontem.seguidores) : null);
  await db.from("ig_snapshots").upsert({
    conta_id: id, data, seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count,
    novos_seguidores: novos, alcance: ins.reach ?? null, visitas_perfil: ins.profile_views ?? null, cliques_site: ins.website_clicks ?? null,
    contas_engajadas: ins.accounts_engaged ?? null, insights: ins,
  });
  return { data, novos, alcance: ins.reach ?? null };
}

async function syncMidias(id: string, tok: string, completo: boolean) {
  let n = 0;
  let next: string | null = `${id}/media`;
  let params: Record<string, string> = { fields: "id,caption,media_type,media_product_type,media_url,permalink,thumbnail_url,timestamp,like_count,comments_count", limit: "25" };
  let paginas = 0;
  while (next && paginas < (completo ? 8 : 1)) {
    const j = await graph(next, tok, params);
    for (const m of j.data || []) {
      const ins = await insightsMidia(m, tok);
      await db.from("ig_midias").upsert({
        id: m.id, conta_id: id, tipo: m.media_type, produto: m.media_product_type, legenda: m.caption || "", url: m.media_url, thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : null),
        permalink: m.permalink, publicado_em: m.timestamp, curtidas: m.like_count ?? 0, comentarios: m.comments_count ?? 0,
        alcance: ins.reach ?? null, salvos: ins.saved ?? null, compartilhamentos: ins.shares ?? null, visualizacoes: ins.views ?? ins.plays ?? null, interacoes: ins.total_interactions ?? null,
        insights: ins, atualizado_em: new Date().toISOString(),
      });
      n++;
    }
    next = j.paging?.next || null; params = {}; paginas++;
  }
  return n;
}

async function insightsMidia(m: Row, tok: string): Promise<Row> {
  const out: Row = {};
  const ehReel = m.media_product_type === "REELS";
  const metric = ehReel ? "reach,saved,shares,views,total_interactions,likes,comments" : (m.media_type === "CAROUSEL_ALBUM" ? "reach,saved,shares,total_interactions,views" : "reach,saved,shares,total_interactions,views");
  try {
    const j = await graph(`${m.id}/insights`, tok, { metric });
    for (const x of j.data || []) out[x.name] = x.values?.[0]?.value ?? x.total_value?.value;
  } catch (e) { out.erro = String(e).slice(0, 100); }
  return out;
}

async function syncComentarios(id: string, tok: string) {
  const { data: midias } = await db.from("ig_midias").select("id").eq("conta_id", id).gt("comentarios", 0).order("publicado_em", { ascending: false }).limit(15);
  let n = 0;
  for (const m of midias || []) {
    try {
      const j = await graph(`${m.id}/comments`, tok, { fields: "id,text,username,timestamp,from,hidden,replies{id,text,username,timestamp,from}", limit: "50" });
      for (const c of j.data || []) {
        const de_mim = c.from?.id === id;
        const respondido = (c.replies?.data || []).some((r: Row) => (r.from as Row)?.id === id);
        const resp = (c.replies?.data || []).find((r: Row) => (r.from as Row)?.id === id) as Row | undefined;
        await db.from("ig_comentarios").upsert({ id: c.id, conta_id: id, midia_id: m.id, autor_id: c.from?.id, autor_username: c.username || c.from?.username, texto: c.text, criado_em: c.timestamp, de_mim, oculto: !!c.hidden, ...(respondido ? { respondido: true, resposta_texto: resp?.text as string } : {}) }, { onConflict: "id" });
        n++;
        for (const r of c.replies?.data || []) {
          await db.from("ig_comentarios").upsert({ id: r.id, conta_id: id, midia_id: m.id, parent_id: c.id, autor_id: r.from?.id, autor_username: r.username || r.from?.username, texto: r.text, criado_em: r.timestamp, de_mim: r.from?.id === id, lido: true }, { onConflict: "id" });
        }
      }
    } catch (e) { await log("erro", id, { onde: "comentarios", midia: m.id, erro: String(e).slice(0, 200) }); }
  }
  return n;
}

async function syncConversas(id: string, tok: string, completo: boolean) {
  let n = 0;
  try {
    const j = await graph("me/conversations", tok, { platform: "instagram", fields: "id,updated_time,participants,messages.limit(" + (completo ? "30" : "10") + "){id,from,to,message,created_time,attachments,reactions,shares,story}", limit: completo ? "50" : "25" });
    for (const c of j.data || []) {
      const outro = (c.participants?.data || []).find((p: Row) => String(p.id) !== id) as Row | undefined;
      if (!outro) continue;
      const conversa_id = `ig:${id}:${outro.id}`;
      const msgs = (c.messages?.data || []) as Row[];
      let naoLidas = 0;
      for (const m of msgs) {
        const de_mim = String((m.from as Row)?.id) === id;
        const tipo = m.story ? "story_reply" : ((m.attachments as Row)?.data ? "anexo" : "texto");
        await db.from("ig_mensagens").upsert({ id: m.id, conversa_id, conta_id: id, de_mim, texto: (m.message as string) || (m.story ? "(respondeu ao story)" : "(anexo)"), tipo, anexos: (m.attachments as Row)?.data || [], criado_em: m.created_time, lido: de_mim }, { onConflict: "id", ignoreDuplicates: true });
      }
      const ultima = msgs[0];
      // não lidas = mensagens dele depois da minha última
      const idxMinha = msgs.findIndex((m) => String((m.from as Row)?.id) === id);
      naoLidas = idxMinha === -1 ? msgs.length : idxMinha;
      const { data: ex } = await db.from("ig_conversas").select("nao_lidas,lead_id,participante_username").eq("id", conversa_id).maybeSingle();
      await db.from("ig_conversas").upsert({
        id: conversa_id, conta_id: id, participante_id: String(outro.id), participante_username: (outro.username as string) || ex?.participante_username || String(outro.id),
        ultima_msg: (ultima?.message as string) || "", ultima_em: (ultima?.created_time as string) || c.updated_time, ultima_de_mim: ultima ? String((ultima.from as Row)?.id) === id : null,
        nao_lidas: ex ? Math.min(ex.nao_lidas ?? 0, naoLidas) || (ex.nao_lidas && naoLidas ? ex.nao_lidas : naoLidas) : naoLidas,
        lead_id: ex?.lead_id || null,
      });
      n++;
    }
  } catch (e) { await log("erro", id, { onde: "conversas", erro: String(e).slice(0, 300) }); return String(e).slice(0, 120); }
  return n;
}

// ======================= AÇÕES NO INSTAGRAM =======================
async function responderComentario(id: string, texto: string, quem: string) {
  const { data: c } = await db.from("ig_comentarios").select("*").eq("id", id).single();
  const tok = await tokenDaConta(c.conta_id);
  if (!tok) throw new Error("conta sem token");
  const r = await graphPost(`${id}/replies`, tok, { message: texto });
  await db.from("ig_comentarios").update({ respondido: true, resposta_texto: texto, lido: true }).eq("id", id);
  await db.from("ig_comentarios").upsert({ id: r.id, conta_id: c.conta_id, midia_id: c.midia_id, parent_id: id, autor_id: c.conta_id, texto, criado_em: new Date().toISOString(), de_mim: true, lido: true, respondido: true });
  await db.from("ig_acoes").update({ status: "feita", feita_em: new Date().toISOString(), feita_por: quem }).eq("comentario_id", id).eq("status", "pendente");
  // depois do público, vai ao direct (fluxo CP) se o autor passa na triagem
  if (c.lead_id) {
    await db.from("ig_acoes").insert({ conta_id: c.conta_id, lead_id: c.lead_id, comentario_id: id, data: hoje(), bloco: 2, tipo: "triagem", titulo: `Triagem de @${c.autor_username} (comentou no post)`, origem: "cp:apos_resposta", url: `https://www.instagram.com/${c.autor_username}/` });
  }
  return { ok: true, id: r.id };
}

async function ocultarComentario(id: string, ocultar: boolean) {
  const { data: c } = await db.from("ig_comentarios").select("conta_id").eq("id", id).single();
  const tok = await tokenDaConta(c.conta_id);
  await graphPost(id, tok!, { hide: ocultar });
  await db.from("ig_comentarios").update({ oculto: ocultar, lido: true }).eq("id", id);
  return { ok: true };
}

async function enviarDM(conversa_id: string, texto: string, quem: string) {
  const { data: cv } = await db.from("ig_conversas").select("*").eq("id", conversa_id).single();
  const tok = await tokenDaConta(cv.conta_id);
  if (!tok) throw new Error("conta sem token");
  const r = await graphPost("me/messages", tok, { recipient: { id: cv.participante_id }, message: { text: texto } });
  const agora = new Date().toISOString();
  await db.from("ig_mensagens").upsert({ id: r.message_id || `local:${Date.now()}`, conversa_id, conta_id: cv.conta_id, de_mim: true, texto, tipo: "texto", criado_em: agora, lido: true });
  await db.from("ig_conversas").update({ ultima_msg: texto, ultima_em: agora, ultima_de_mim: true, nao_lidas: 0 }).eq("id", conversa_id);
  await db.from("ig_acoes").update({ status: "feita", feita_em: agora, feita_por: quem }).eq("conversa_id", conversa_id).eq("status", "pendente").in("tipo", ["responder_dm", "avancar", "ativar", "followup"]);
  if (cv.lead_id) {
    const { data: l } = await db.from("ig_leads").select("etapa,toques").eq("id", cv.lead_id).single();
    const upd: Row = { ultimo_toque: agora, toques: (l?.toques || 0) + 1 };
    if (l?.etapa === "novo" || l?.etapa === "aquecendo") { upd.etapa = "ativado"; upd.proximo_toque = somaDias(hoje(), 2); }
    await db.from("ig_leads").update(upd).eq("id", cv.lead_id);
  }
  return { ok: true, id: r.message_id };
}

// ======================= LEAD: PESQUISA + IA =======================
async function pesquisarLead(conta_id: string, username: string, quem: string, extra: Row) {
  username = username.replace(/^@/, "").trim().toLowerCase();
  if (!username) throw new Error("username vazio");
  const tok = await tokenDaConta(conta_id);
  if (!tok) throw new Error("conta sem token");
  let perfil: Row = {};
  try {
    const j = await graph(conta_id, tok, { fields: `business_discovery.username(${username}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(8){caption,like_count,comments_count,media_type,permalink,timestamp}}` });
    perfil = j.business_discovery || {};
  } catch (e) {
    perfil = { erro: String(e).includes("2207013") || String(e).toLowerCase().includes("not found") ? "perfil não é business/creator ou não existe (business_discovery só lê contas profissionais)" : String(e).slice(0, 200) };
  }
  // IA: triagem + conexão + mensagem
  const fluxo = String(extra.fluxo || "NS");
  const prompt = `${PLAYBOOK_IA}

TAREFA: triagem de ICP (nível 1) e rascunho da mensagem de ativação para um perfil que chegou pelo fluxo ${fluxo}.
Dados do perfil (business_discovery do Instagram; se vier erro, use só o username e diga que precisa de pesquisa manual):
${JSON.stringify(perfil).slice(0, 6000)}
${extra.sinal ? `Sinal de calor informado: ${extra.sinal}` : ""}
Hora atual: ${saudacao()}.

Responda SÓ JSON com:
{"icp":"passa|nao_passa|indefinido","motivo":"1 linha","nome":"primeiro nome provável ou vazio","restaurante":"nome ou vazio","cidade":"ou vazio","segmento":"self-service|a quilo|churrascaria|marmitaria|pizzaria|delivery|bar|outro|desconhecido","porte":"pequeno|medio|rede","sinais":["..."],"modelo":1-12,"conexao":"o detalhe específico, verdadeiro, tirado do perfil (sem elogio genérico)","pergunta_factual":"uma pergunta de zero esforço","mensagem":"a mensagem completa de ativação (versão A), 3 a 4 linhas, pronta para colar","pesquisa_profunda":true|false}`;
  let ia: Row = {};
  try { ia = JSON.parse(await gemini(prompt, { json: true, temp: 0.6 })); } catch (e) { ia = { erro: String(e).slice(0, 200) }; }
  const { data: ex } = await db.from("ig_leads").select("id").eq("conta_id", conta_id).eq("username", username).maybeSingle();
  const row: Row = {
    conta_id, username, fluxo, perfil, icp: (ia.icp as string) || "indefinido",
    nome: (ia.nome as string) || (perfil.name as string) || null, restaurante: (ia.restaurante as string) || null, cidade: (ia.cidade as string) || null, segmento: (ia.segmento as string) || null,
    conexao: (ia.conexao as string) || null, sinal_calor: (extra.sinal as string) || ((ia.sinais as string[]) || []).join(", ") || null,
    pesquisa: ia.motivo ? `IA: ${ia.motivo}${ia.pesquisa_profunda ? " · Pesquisa profunda recomendada (conta grande)." : ""}` : null,
    etapa: ia.icp === "nao_passa" ? "fora_icp" : "aquecendo", criado_por: quem,
  };
  let lead_id = ex?.id;
  if (ex) { await db.from("ig_leads").update(row).eq("id", ex.id); } else { const { data } = await db.from("ig_leads").insert(row).select("id").single(); lead_id = data?.id; }
  // ações: reciprocidade + ativação (se passa)
  if (ia.icp !== "nao_passa") {
    const base = { conta_id, lead_id, data: hoje(), origem: `pesquisa:${fluxo}` };
    await db.from("ig_acoes").insert([
      { ...base, bloco: fluxo === "OB" ? 8 : 4, tipo: "seguir", titulo: `Reciprocidade: seguir @${username}, curtir 2 posts, reagir a 1 story`, url: `https://www.instagram.com/${username}/` },
      ...(fluxo === "OB"
        ? [{ ...base, bloco: 8, data: somaDias(hoje(), 1), tipo: "comentar", titulo: `Comentar 1 post de @${username} com valor (nunca "top!")`, url: `https://www.instagram.com/${username}/` },
           { ...base, bloco: 8, data: somaDias(hoje(), 2), tipo: "ativar", titulo: `Ativar @${username} (mensagem de ativação)`, texto: ia.mensagem as string, url: `https://ig.me/m/${username}` }]
        : [{ ...base, bloco: 4, tipo: "ativar", titulo: `Ativar @${username} (boas-vindas, modelo ${ia.modelo || "-"})`, texto: ia.mensagem as string, url: `https://ig.me/m/${username}` }]),
    ]);
    await db.from("ig_acoes").update({ status: "feita", feita_em: new Date().toISOString(), feita_por: quem }).eq("lead_id", lead_id).eq("tipo", "triagem").eq("status", "pendente");
  } else {
    await db.from("ig_acoes").update({ status: "pulada", feita_em: new Date().toISOString(), feita_por: quem }).eq("lead_id", lead_id).eq("status", "pendente");
  }
  return { lead_id, perfil, ia };
}

async function sugerir(tipo: string, id: string) {
  if (tipo === "comentario") {
    const { data: c0 } = await db.from("ig_comentarios").select("*").eq("id", id).single();
    const { data: md } = c0?.midia_id ? await db.from("ig_midias").select("legenda").eq("id", c0.midia_id).maybeSingle() : { data: null };
    const c = { ...c0, ig_midias: md };
    const prompt = `${PLAYBOOK_IA}
TAREFA: um seguidor comentou num post do Charles. Escreva a resposta PÚBLICA (1 a 2 linhas, agrega valor, sem "top!", sem "obrigado" seco, pode terminar com uma pergunta curta) e um abridor de DIRECT (2 a 3 linhas, referência ao comentário dele, uma pergunta factual).
Legenda do post: ${(c.ig_midias?.legenda || "").slice(0, 800)}
Comentário de @${c.autor_username}: ${c.texto}
Responda SÓ JSON: {"resposta_publica":"...","abridor_direct":"...","ehLead":true|false,"motivo":"1 linha"}`;
    const ia = JSON.parse(await gemini(prompt, { json: true }));
    await db.from("ig_comentarios").update({ sugestao_ia: ia.resposta_publica }).eq("id", id);
    return ia;
  }
  // dm
  const { data: cv } = await db.from("ig_conversas").select("*, ig_leads(*)").eq("id", id).single();
  const { data: msgs } = await db.from("ig_mensagens").select("de_mim,texto,tipo,criado_em").eq("conversa_id", id).order("criado_em", { ascending: false }).limit(30);
  const hist = (msgs || []).reverse().map((m) => `${m.de_mim ? "CHARLES" : "LEAD"}: ${m.texto}`).join("\n");
  const l = cv.ig_leads || {};
  const prompt = `${PLAYBOOK_IA}
TAREFA: continuar esta conversa de direct seguindo as camadas. Identifique em que camada/degrau a conversa está e escreva a PRÓXIMA mensagem do Charles (3 a 4 linhas, uma pergunta no final, saudação temporal só se for a primeira do dia). Se o lead fez objeção, use a quebra correspondente. Se o lead já respondeu o degrau 4, vá para a faixa de faturamento; se já deu a faixa, faça o convite com prova social; se aceitou, ofereça dois horários.
Hora atual: ${saudacao()}.
Lead: @${cv.participante_username} · nome: ${l.nome || "?"} · restaurante: ${l.restaurante || "?"} · cidade: ${l.cidade || "?"} · fluxo: ${l.fluxo || "?"} · etapa atual: ${ETAPAS[l.etapa] || l.etapa || "?"} · faixa: ${l.faixa || "?"} · desafio registrado: ${l.desafio || "-"} · ganho (degrau 4): ${l.ganho || "-"}
Histórico (mais antigo primeiro):
${hist || "(sem mensagens ainda)"}

Responda SÓ JSON: {"camada":0-4,"degrau":0-4,"mensagem":"...","etapa_sugerida":"novo|aquecendo|ativado|rmv|desafio|escada|convite|agendado_charles|agendado_guilherme|frio|fora_icp","desafio":"frase LITERAL do lead sobre o desafio, se apareceu, senão vazio","ganho":"frase LITERAL do degrau 4, se apareceu, senão vazio","faixa":"ate100|100a300|300a500|acima500|","objecao":"nome da objeção se houver, senão vazio","observacao":"1 linha para o SDR"}`;
  const ia = JSON.parse(await gemini(prompt, { json: true, temp: 0.7 }));
  // atualiza o lead com o que a IA extraiu (sem sobrescrever o que já tem)
  if (cv.lead_id) {
    const upd: Row = {};
    if (ia.desafio && !l.desafio) upd.desafio = ia.desafio;
    if (ia.ganho && !l.ganho) upd.ganho = ia.ganho;
    if (ia.faixa && !l.faixa) upd.faixa = ia.faixa;
    if (Object.keys(upd).length) await db.from("ig_leads").update(upd).eq("id", cv.lead_id);
    await db.from("ig_conversas").update({ camada: ia.camada }).eq("id", id);
  }
  return ia;
}

async function classificarMidias(conta_id: string) {
  const { data: ms } = await db.from("ig_midias").select("id,legenda").eq("conta_id", conta_id).is("categoria", null).order("publicado_em", { ascending: false }).limit(40);
  if (!ms?.length) return { n: 0 };
  const prompt = `Classifique cada post do Instagram de um consultor de restaurantes no motor de conteúdo "3 por 2": dor (dor nomeada do dono), bastidor (caso real sem nome), ensino (prática: CMV, folha, precificação), convite (convite ao diagnóstico), resultado (resultado de cliente com número), outro.
Posts: ${JSON.stringify(ms.map((m) => ({ id: m.id, legenda: (m.legenda || "").slice(0, 300) })))}
Responda SÓ JSON: {"<id>":"categoria", ...}`;
  const ia = JSON.parse(await gemini(prompt, { json: true, temp: 0.2 }));
  let n = 0;
  for (const [id, cat] of Object.entries(ia)) { await db.from("ig_midias").update({ categoria: String(cat) }).eq("id", id); n++; }
  return { n };
}

// ======================= CRIAÇÃO DE CONTEÚDO (IA) =======================
// body: { conta_id, modo: 'ideias'|'post'|'carrossel'|'reel'|'story'|'reescrever', tema?, categoria?, texto?, tom? }
async function criarConteudo(body: Row) {
  const conta_id = String(body.conta_id || "");
  const { data: conta } = await db.from("ig_contas").select("username,biografia").eq("id", conta_id).maybeSingle();
  const { data: tops } = await db.from("ig_midias").select("legenda,interacoes,alcance,categoria").eq("conta_id", conta_id).order("interacoes", { ascending: false, nullsFirst: false }).limit(5);
  const base = `Você escreve para o Instagram do Charles (@${conta?.username || "charles.simon"}), consultor de restaurantes do Programa Lucro e Liberdade (gestão financeira e gestão de pessoas para donos de restaurante, self-service, a quilo, churrascaria, marmitaria, pizzaria, delivery). Público: donos de restaurante que faturam de 100 a 500 mil por mês, cansados, que faturam bem e sobra pouco.
Tom: direto, de quem está na operação, português do Brasil falado, frases curtas, zero jargão de marketing, zero "você sabia que", no máximo 1 emoji por texto, nunca travessão. Dados reais do nicho quando possível (CMV saudável 30%, folha 25%, lucro mínimo 15%).
Motor de conteúdo 3 por 2 (ciclo de 5 publicações): dor (dor nomeada: "Restaurante que fatura 300 mil e o dono tira 4 mil"), bastidor (caso real sem nome), ensino (como calcular CMV, o que olhar na folha, o erro de precificação do quilo), convite (Diagnóstico Individual Estratégico: 40 min por vídeo, sem custo, sai sabendo quanto vira lucro e os 3 maiores vazamentos), resultado (resultado de cliente com número).
Posts que mais engajaram desta conta (para referência de estilo): ${JSON.stringify((tops || []).map((t) => ({ legenda: (t.legenda || "").slice(0, 200), interacoes: t.interacoes, categoria: t.categoria })))}
`;
  const modo = String(body.modo || "ideias");
  const tema = String(body.tema || "");
  const cat = String(body.categoria || "");
  let tarefa = "";
  if (modo === "ideias") tarefa = `Gere 6 ideias de conteúdo${cat ? ` da categoria "${cat}"` : " cobrindo o ciclo 3 por 2 (dor, bastidor, ensino, convite, resultado, mais 1 dor)"}${tema ? ` sobre: ${tema}` : ""}. Responda SÓ JSON: {"ideias":[{"categoria":"dor|bastidor|ensino|convite|resultado","formato":"post|carrossel|reel|story","titulo":"...","gancho":"primeira frase que para o dedo (até 12 palavras)","resumo":"2 linhas do que o conteúdo entrega"}]}`;
  else if (modo === "post") tarefa = `Escreva um post (imagem única) ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Responda SÓ JSON: {"titulo":"...","gancho":"texto da imagem, até 10 palavras","legenda":"legenda completa de 6 a 10 linhas, com quebras de linha, terminando com uma pergunta ou CTA","cta":"...","hashtags":"8 a 12 hashtags do nicho, separadas por espaço"}`;
  else if (modo === "carrossel") tarefa = `Escreva um carrossel de 7 a 9 slides ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Responda SÓ JSON: {"titulo":"...","gancho":"capa, até 10 palavras","roteiro":"Slide 1: ...\\nSlide 2: ...\\n(cada slide com título curto e 1 a 2 frases)","legenda":"legenda de 4 a 6 linhas","cta":"último slide","hashtags":"..."}`;
  else if (modo === "reel") tarefa = `Escreva o roteiro de um reel de 30 a 45 segundos ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Responda SÓ JSON: {"titulo":"...","gancho":"os 3 primeiros segundos, falado","roteiro":"[0-3s] ...\\n[3-15s] ...\\n[15-35s] ...\\n[35-45s] CTA","legenda":"legenda de 3 a 5 linhas","cta":"...","hashtags":"..."}`;
  else if (modo === "story") tarefa = `Crie uma sequência de 3 a 4 stories ${cat ? `da categoria ${cat} ` : ""}sobre: ${tema}. Um deles deve ser de captura (enquete, quiz ou caixinha) com a pergunta pronta. Responda SÓ JSON: {"titulo":"...","roteiro":"Story 1 (texto na tela + o que falar)...\\nStory 2...\\nStory 3 (CAPTURA: enquete/quiz/caixinha com as opções)...","legenda":"","cta":"...","hashtags":""}`;
  else if (modo === "reescrever") tarefa = `Reescreva o texto abaixo no tom descrito, mantendo o sentido, mais curto e mais forte. Texto:\n${String(body.texto || "")}\nResponda SÓ JSON: {"legenda":"texto reescrito"}`;
  const out = JSON.parse(await gemini(base + "\n" + tarefa + (body.tom ? `\nAjuste de tom pedido: ${body.tom}` : ""), { json: true, temp: 0.8 }));
  return out;
}

// ======================= PUBLICAR NO INSTAGRAM =======================
// body: { conta_id, planejado_id?, tipo: 'post'|'reel'|'carrossel', midia_url | midia_urls[], legenda }
async function publicar(body: Row, quem: string) {
  const conta_id = String(body.conta_id || "");
  const tok = await tokenDaConta(conta_id);
  if (!tok) throw new Error("conta sem token");
  const legenda = String(body.legenda || "");
  const tipo = String(body.tipo || "post");
  let creation: string;
  if (tipo === "carrossel") {
    const urls = (body.midia_urls as string[]) || [];
    if (urls.length < 2) throw new Error("carrossel precisa de 2 a 10 imagens");
    const filhos: string[] = [];
    for (const u of urls) { const c = await graphPost(`${conta_id}/media`, tok, { image_url: u, is_carousel_item: true }); filhos.push(c.id); }
    creation = (await graphPost(`${conta_id}/media`, tok, { media_type: "CAROUSEL", children: filhos.join(","), caption: legenda })).id;
  } else if (tipo === "reel") {
    creation = (await graphPost(`${conta_id}/media`, tok, { media_type: "REELS", video_url: String(body.midia_url), caption: legenda, share_to_feed: true })).id;
    // vídeo processa em segundo plano: espera até ficar FINISHED (máx ~90 s)
    for (let i = 0; i < 18; i++) {
      const st = await graph(creation, tok, { fields: "status_code,status" });
      if (st.status_code === "FINISHED") break;
      if (st.status_code === "ERROR") throw new Error("Instagram não processou o vídeo: " + JSON.stringify(st.status));
      await new Promise((r) => setTimeout(r, 5000));
    }
  } else {
    creation = (await graphPost(`${conta_id}/media`, tok, { image_url: String(body.midia_url), caption: legenda })).id;
  }
  const pub = await graphPost(`${conta_id}/media_publish`, tok, { creation_id: creation });
  if (body.planejado_id) await db.from("ig_planejados").update({ status: "publicado", ig_media_id: pub.id, publicado_em: new Date().toISOString() }).eq("id", String(body.planejado_id));
  await log("acao", conta_id, { tipo: "publicar", por: quem, media_id: pub.id, formato: tipo });
  // puxa a mídia nova para a biblioteca
  try { await syncMidias(conta_id, tok, false); } catch { /* o cron pega depois */ }
  return { ok: true, media_id: pub.id };
}

// ======================= FILA DO DIA =======================
async function gerarFila(conta_id: string, data: string) {
  if (!conta_id) throw new Error("conta_id obrigatório");
  const { data: conta } = await db.from("ig_contas").select("*").eq("id", conta_id).single();
  const cfg = (conta.config || {}) as Row;
  const dow = new Date(data + "T12:00:00-03:00").getDay();
  const inicio = (cfg.inicio as string) || (conta.conectado_em as string).slice(0, 10);
  const dias = Math.max(0, Math.round((new Date(data).getTime() - new Date(inicio).getTime()) / 864e5));
  const limite = limiteDiario(dias, Number(cfg.max_dia) || 80);
  const { data: existentes } = await db.from("ig_acoes").select("tipo,lead_id,conversa_id,comentario_id,origem").eq("conta_id", conta_id).eq("data", data);
  const ja = new Set((existentes || []).map((a) => `${a.tipo}|${a.lead_id || a.conversa_id || a.comentario_id || a.origem}`));
  const novas: Row[] = [];
  const add = (a: Row) => { const k = `${a.tipo}|${a.lead_id || a.conversa_id || a.comentario_id || a.origem}`; if (!ja.has(k)) { ja.add(k); novas.push({ conta_id, data, status: "pendente", ...a }); } };

  // 1) story de captura (seg a sex)
  const sc = STORY_CAPTURA[dow];
  if (sc && !(cfg.sem_story_captura)) {
    add({ bloco: 1, tipo: "story_captura", titulo: `08:30 · Story de captura: ${sc.formato}`, texto: sc.texto, origem: "rotina:story1", url: "https://www.instagram.com/" });
    add({ bloco: 6, tipo: "story_captura", titulo: "14:00 · Segundo story + plantão no direct", texto: "Publica o segundo story do dia e fica no direct por 30 min. Atraso de 1 hora corta a conversão pela metade.", origem: "rotina:story2", url: "https://www.instagram.com/" });
  }
  // 2) inbound: comentários sem resposta e DMs não lidas
  const { data: coms } = await db.from("ig_comentarios").select("id,autor_username,texto,lead_id").eq("conta_id", conta_id).eq("de_mim", false).eq("respondido", false).eq("oculto", false).is("parent_id", null).order("criado_em", { ascending: false }).limit(40);
  for (const c of coms || []) add({ bloco: 2, tipo: "responder_comentario", comentario_id: c.id, lead_id: c.lead_id, titulo: `Responder @${c.autor_username} no post`, texto: c.texto, origem: "rotina:comentarios", url: `https://www.instagram.com/${c.autor_username}/` });
  const { data: convs } = await db.from("ig_conversas").select("id,participante_username,ultima_msg,lead_id,nao_lidas,ultima_de_mim").eq("conta_id", conta_id).eq("arquivada", false).gt("nao_lidas", 0).order("ultima_em", { ascending: false }).limit(60);
  for (const c of convs || []) add({ bloco: 2, tipo: "responder_dm", conversa_id: c.id, lead_id: c.lead_id, titulo: `Responder @${c.participante_username} no direct`, texto: c.ultima_msg, origem: "rotina:inbox", url: `https://ig.me/m/${c.participante_username}` });
  // 3) conversas abertas nas camadas 2-4 onde a última é dele e já foi lida
  const { data: abertas } = await db.from("ig_leads").select("id,username,etapa,conversa_id").eq("conta_id", conta_id).in("etapa", ["rmv", "desafio", "escada", "convite"]).limit(80);
  for (const l of abertas || []) {
    const { data: cv } = await db.from("ig_conversas").select("id,ultima_de_mim,nao_lidas").eq("conta_id", conta_id).or(`lead_id.eq.${l.id}${l.conversa_id ? `,id.eq.${l.conversa_id}` : ""}`).maybeSingle();
    if (cv && cv.ultima_de_mim === false && !cv.nao_lidas) add({ bloco: 3, tipo: "avancar", conversa_id: cv.id, lead_id: l.id, titulo: `Avançar @${l.username} (${ETAPAS[l.etapa]})`, origem: "rotina:conversas", url: `https://ig.me/m/${l.username}` });
  }
  // 4) novos seguidores / leads novos: triagem (até 20)
  const { data: novosLeads } = await db.from("ig_leads").select("id,username,fluxo").eq("conta_id", conta_id).eq("etapa", "novo").in("fluxo", ["SC", "RS", "CP", "NS"]).order("criado_em", { ascending: false }).limit(20);
  for (const l of novosLeads || []) add({ bloco: 4, tipo: "triagem", lead_id: l.id, titulo: `Triagem de @${l.username} (${l.fluxo})`, texto: "60 segundos: dono? restaurante? ativo? Sinal de calor? Se passa, pesquisar e ativar.", origem: "rotina:triagem", url: `https://www.instagram.com/${l.username}/` });
  // 5) follow-ups D+2 / D+5 / D+10
  const { data: fups } = await db.from("ig_leads").select("id,username,nome,restaurante,toques,ultimo_toque,proximo_toque").eq("conta_id", conta_id).eq("etapa", "ativado").lte("proximo_toque", data).limit(40);
  for (const l of fups || []) {
    const t = Math.min(Math.max((l.toques || 1), 1), 3); // toques já dados: 1 => próximo é o 2
    const c = CADENCIA[t - 1];
    if (!c) continue;
    add({ bloco: 5, tipo: "followup", lead_id: l.id, titulo: `${c.titulo}: @${l.username}`, texto: c.texto.replace(/\[Nome\]/g, l.nome || l.username).replace(/\[restaurante\]/g, l.restaurante || "restaurante"), origem: `rotina:followup${c.toque}`, url: `https://ig.me/m/${l.username}` });
  }
  // 7) visita sincera: frios há 60+ dias e leads sem toque há 30 dias (até 25)
  const corte60 = somaDias(data, -60), corte30 = somaDias(data, -30);
  const { data: frios } = await db.from("ig_leads").select("id,username").eq("conta_id", conta_id).eq("etapa", "frio").lte("ultimo_toque", corte60 + "T23:59:59").limit(25);
  for (const l of frios || []) add({ bloco: 7, tipo: "visita", lead_id: l.id, titulo: `Visita sincera: @${l.username} (frio há 60 dias)`, texto: "Ver stories, reagir a 1, curtir o último post. Se tiver gancho novo, reativar com pergunta factual nova.", origem: "rotina:vs", url: `https://www.instagram.com/stories/${l.username}/` });
  const { data: quentes } = await db.from("ig_leads").select("id,username").eq("conta_id", conta_id).in("etapa", ["rmv", "desafio", "escada", "convite", "agendado_charles", "agendado_guilherme"]).lte("ultimo_toque", corte30 + "T23:59:59").limit(10);
  for (const l of quentes || []) add({ bloco: 7, tipo: "reagir_story", lead_id: l.id, titulo: `Manter calor: reagir a 1 story de @${l.username}`, origem: "rotina:calor", url: `https://www.instagram.com/stories/${l.username}/` });
  // 8) outbound: leads OB em aquecimento sem ação hoje
  const { data: obs } = await db.from("ig_leads").select("id,username").eq("conta_id", conta_id).eq("fluxo", "OB").eq("etapa", "novo").limit(15);
  for (const l of obs || []) add({ bloco: 8, tipo: "pesquisa", lead_id: l.id, titulo: `Outbound: pesquisar e aquecer @${l.username}`, texto: "Dia 0: segue, curte 3 posts, vê todos os stories e reage a 1. Use 'Pesquisar com IA' no lead para gerar a conexão e a mensagem.", origem: "rotina:ob", url: `https://www.instagram.com/${l.username}/` });
  // 9) fechamento
  add({ bloco: 9, tipo: "registrar", titulo: "16:30 · LeadForge, confirmações de amanhã (D-1 às 18h) e números do dia", texto: "Registrar no LeadForge todo lead tocado hoje (campos: desafio nas palavras dele + o que mudaria). Mandar confirmação D-1 para os diagnósticos de amanhã.", origem: "rotina:fechamento" });

  if (novas.length) await db.from("ig_acoes").insert(novas);
  // teto de mensagens novas do dia (ativar + followup): marca as excedentes como 'pulada' com aviso
  const { data: msgsHoje } = await db.from("ig_acoes").select("id").eq("conta_id", conta_id).eq("data", data).in("tipo", ["ativar", "followup"]).eq("status", "pendente").order("bloco").order("criado_em");
  const excedentes = (msgsHoje || []).slice(limite);
  if (excedentes.length) await db.from("ig_acoes").update({ status: "pulada", feita_por: "limite", titulo: undefined }).in("id", excedentes.map((a) => a.id));
  await log("fila", conta_id, { data, novas: novas.length, limite, dias_operacao: dias, excedentes: excedentes.length });
  return { novas: novas.length, limite, dias_operacao: dias, excedentes: excedentes.length };
}

function somaDias(d: string, n: number) { const x = new Date(d + "T12:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
