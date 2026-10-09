// Edge Function: ig-webhook
// Recebe os webhooks do Instagram (objeto "instagram"): comentários novos e mensagens do direct.
//   GET  -> verificação (hub.challenge) com IG_WEBHOOK_VERIFY
//   POST -> grava comentário/mensagem, abre lead quando faz sentido e cria a ação na fila do dia.
// Deploy: supabase functions deploy ig-webhook --project-ref fvcbxorfstqqeewocxkf --use-api --no-verify-jwt
// Na Meta: Callback URL = https://fvcbxorfstqqeewocxkf.supabase.co/functions/v1/ig-webhook ; campos: comments, messages
import { admin, APP_SECRET, CORS, graph, hoje, json, log, tokenDaConta, VERIFY_TOKEN } from "../_shared/ig.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);

  if (req.method === "GET") {
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === VERIFY_TOKEN) {
      return new Response(url.searchParams.get("hub.challenge") || "", { status: 200 });
    }
    return new Response("verify_token inválido", { status: 403 });
  }

  const raw = await req.text();
  // assinatura (quando a Meta manda)
  const sig = req.headers.get("x-hub-signature-256");
  if (sig && APP_SECRET) {
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(APP_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw));
    const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
    if (`sha256=${hex}` !== sig) { await log("erro", null, { onde: "webhook", erro: "assinatura inválida" }); return new Response("bad sig", { status: 403 }); }
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw); } catch { return json({ ok: false }, 400); }
  await log("webhook", null, body);

  // responde rápido e processa; a Meta reenvia se não receber 200 em alguns segundos
  try { await processar(body); } catch (e) { await log("erro", null, { onde: "webhook.processar", erro: String(e) }); }
  return json({ ok: true });
});

async function processar(body: Record<string, unknown>) {
  if (body.object !== "instagram") return;
  const db = admin();
  for (const entry of (body.entry as Array<Record<string, unknown>>) || []) {
    const conta_id = String(entry.id);
    // --- comentários ---
    for (const ch of (entry.changes as Array<{ field: string; value: Record<string, unknown> }>) || []) {
      if (ch.field !== "comments") continue;
      const v = ch.value as { id: string; text?: string; from?: { id: string; username: string }; media?: { id: string }; parent_id?: string };
      const de_mim = v.from?.id === conta_id;
      const { error } = await db.from("ig_comentarios").upsert({
        id: v.id, conta_id, midia_id: v.media?.id, parent_id: v.parent_id || null,
        autor_id: v.from?.id, autor_username: v.from?.username, texto: v.text || "",
        criado_em: new Date().toISOString(), de_mim, lido: de_mim,
      }, { onConflict: "id", ignoreDuplicates: false });
      if (error) throw error;
      if (de_mim) continue;
      // conta o comentário na mídia
      await db.rpc("ig_inc_comentarios", { p_midia: v.media?.id }).then(() => {}, () => {});
      // fluxo CP: lead + ação na fila (responder em público, depois direct)
      const lead = await garantirLead(conta_id, v.from?.username || "", v.from?.id, "CP", `comentou: "${(v.text || "").slice(0, 80)}"`);
      await db.from("ig_acoes").insert({
        conta_id, lead_id: lead?.id, comentario_id: v.id, data: hoje(), bloco: 2, tipo: "responder_comentario",
        titulo: `Responder @${v.from?.username} no post`, texto: v.text || "", origem: "webhook:comments",
        url: `https://www.instagram.com/${v.from?.username}/`,
      });
    }
    // --- mensagens ---
    for (const m of (entry.messaging as Array<Record<string, unknown>>) || []) {
      const sender = (m.sender as { id: string })?.id;
      const recipient = (m.recipient as { id: string })?.id;
      const msg = m.message as { mid: string; text?: string; attachments?: unknown[]; is_echo?: boolean; reply_to?: { story?: { url: string; id: string } } } | undefined;
      const reaction = m.reaction as { mid: string; action: string; emoji?: string; reaction?: string } | undefined;
      const ts = new Date(Number(m.timestamp) || Date.now()).toISOString();
      const de_mim = !!msg?.is_echo || sender === conta_id;
      const outro = de_mim ? recipient : sender;
      if (!outro) continue;
      const conversa_id = `ig:${conta_id}:${outro}`;
      // garante a conversa (busca username pelo IGSID quando não temos)
      const { data: conv } = await db.from("ig_conversas").select("id,participante_username,lead_id,nao_lidas").eq("id", conversa_id).maybeSingle();
      let username = conv?.participante_username || "";
      let nome = "", foto = "";
      if (!conv || !username) {
        try {
          const tok = await tokenDaConta(conta_id);
          if (tok) { const p = await graph(outro, tok, { fields: "username,name,profile_pic,follower_count,is_user_follow_business,is_business_follow_user" }); username = p.username || username; nome = p.name || ""; foto = p.profile_pic || ""; }
        } catch (e) { await log("erro", conta_id, { onde: "perfil IGSID", erro: String(e) }); }
      }
      let texto = msg?.text || "";
      let tipo = "texto";
      if (reaction) { tipo = "reaction"; texto = reaction.action === "react" ? `reagiu ${reaction.emoji || reaction.reaction || ""} a uma mensagem` : "removeu a reação"; }
      else if (msg?.reply_to?.story) { tipo = "story_reply"; texto = texto || "(respondeu ao story)"; }
      else if ((msg?.attachments || []).some((a: unknown) => (a as { type?: string }).type === "story_mention")) { tipo = "story_mention"; texto = texto || "(te mencionou em um story)"; }
      else if ((msg?.attachments || []).length) { tipo = "anexo"; texto = texto || "(anexo)"; }
      const mid = msg?.mid || reaction?.mid + ":r:" + ts;
      if (!mid) continue;
      await db.from("ig_mensagens").upsert({ id: mid, conversa_id, conta_id, de_mim, texto, tipo, anexos: msg?.attachments || [], criado_em: ts, lido: de_mim });
      // lead: resposta a story = fluxo RS (quente); mensagem espontânea = NS/inbound
      let lead_id = conv?.lead_id || null;
      if (!de_mim && username) {
        const fluxo = tipo === "story_reply" || tipo === "story_mention" ? "RS" : "NS";
        const lead = await garantirLead(conta_id, username, outro, fluxo, tipo === "story_reply" ? "respondeu story" : "mandou direct");
        lead_id = lead?.id || lead_id;
        if (lead && lead.etapa === "ativado") await db.from("ig_leads").update({ etapa: "rmv", ultimo_toque: ts }).eq("id", lead.id);
      }
      await db.from("ig_conversas").upsert({
        id: conversa_id, conta_id, participante_id: outro,
        participante_username: username || conv?.participante_username || outro,
        ...(nome ? { participante_nome: nome } : {}), ...(foto ? { participante_foto: foto } : {}),
        ultima_msg: texto, ultima_em: ts, ultima_de_mim: de_mim,
        nao_lidas: de_mim ? 0 : (conv?.nao_lidas || 0) + 1, lead_id, arquivada: false,
      });
      if (!de_mim) {
        // SLA: inbound quente vai pro bloco 2 (responder em até 5 min)
        const { data: ja } = await db.from("ig_acoes").select("id").eq("conversa_id", conversa_id).eq("status", "pendente").eq("tipo", "responder_dm").maybeSingle();
        if (!ja) await db.from("ig_acoes").insert({ conta_id, lead_id, conversa_id, data: hoje(), bloco: 2, tipo: "responder_dm", titulo: `Responder @${username || outro} no direct`, texto, origem: "webhook:messages", url: `https://ig.me/m/${username}` });
      } else {
        // respondemos: marca a ação como feita
        await db.from("ig_acoes").update({ status: "feita", feita_em: ts, feita_por: "instagram" }).eq("conversa_id", conversa_id).eq("status", "pendente").eq("tipo", "responder_dm");
      }
    }
  }
}

async function garantirLead(conta_id: string, username: string, ig_user_id: string | undefined, fluxo: string, sinal: string) {
  if (!username) return null;
  const db = admin();
  const { data: ex } = await db.from("ig_leads").select("id,etapa,fluxo").eq("conta_id", conta_id).eq("username", username).maybeSingle();
  if (ex) {
    const quente = { SC: 1, RS: 2, CP: 3, NS: 4, VS: 5, OB: 6 } as Record<string, number>;
    const upd: Record<string, unknown> = { ultimo_toque: new Date().toISOString(), ...(ig_user_id ? { ig_user_id } : {}) };
    if ((quente[fluxo] || 9) < (quente[ex.fluxo] || 9)) upd.fluxo = fluxo; // sobe o fluxo quando esquenta
    await db.from("ig_leads").update(upd).eq("id", ex.id);
    return ex;
  }
  const { data } = await db.from("ig_leads").insert({ conta_id, username, ig_user_id, fluxo, etapa: "novo", sinal_calor: sinal, criado_por: "webhook" }).select("id,etapa,fluxo").single();
  return data;
}
