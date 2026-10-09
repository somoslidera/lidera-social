// Edge Function: ig-auth
// Login com Instagram (Instagram API with Instagram Login). Fluxo:
//   GET /ig-auth/start?u=<email>      -> redireciona para a tela de autorização do Instagram
//   GET /ig-auth/callback?code=...    -> troca o code por token curto, depois longo (60 dias), salva a conta
//   POST /ig-auth/refresh {conta_id}  -> renova o token longo (chamado pelo cron antes de vencer)
// Deploy: supabase functions deploy ig-auth --project-ref fvcbxorfstqqeewocxkf --use-api --no-verify-jwt
// Secrets: IG_APP_ID, IG_APP_SECRET, IG_APP_URL (front), IG_CRON_SECRET
import { admin, APP_ID, APP_SECRET, APP_URL, CORS, CRON_SECRET, graph, graphPost, html, json, log, SCOPES, SUPABASE_URL, tokenDaConta } from "../_shared/ig.ts";

const REDIRECT = `${SUPABASE_URL}/functions/v1/ig-auth/callback`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const rota = url.pathname.split("/ig-auth")[1] || "/";

  if (rota === "/start") {
    if (!APP_ID) return html(pagina("Falta configurar IG_APP_ID e IG_APP_SECRET nos secrets do Supabase."), 500);
    const state = url.searchParams.get("u") || "";
    const auth = new URL("https://www.instagram.com/oauth/authorize");
    auth.searchParams.set("client_id", APP_ID);
    auth.searchParams.set("redirect_uri", REDIRECT);
    auth.searchParams.set("response_type", "code");
    auth.searchParams.set("scope", SCOPES);
    auth.searchParams.set("state", state);
    auth.searchParams.set("enable_fb_login", "0");
    auth.searchParams.set("force_authentication", "1");
    return Response.redirect(auth.toString(), 302);
  }

  if (rota === "/callback") {
    const code = url.searchParams.get("code");
    const erro = url.searchParams.get("error_description") || url.searchParams.get("error");
    if (erro || !code) return html(pagina(`O Instagram não autorizou: ${erro || "sem code"}.`), 400);
    try {
      // 1) token curto
      const form = new URLSearchParams({ client_id: APP_ID, client_secret: APP_SECRET, grant_type: "authorization_code", redirect_uri: REDIRECT, code: code.replace(/#_$/, "") });
      const r1 = await fetch("https://api.instagram.com/oauth/access_token", { method: "POST", body: form });
      const j1 = await r1.json();
      if (!r1.ok || !j1.access_token) throw new Error(`token curto: ${JSON.stringify(j1)}`);
      // 2) token longo (60 dias)
      const r2 = await fetch(`https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${APP_SECRET}&access_token=${j1.access_token}`);
      const j2 = await r2.json();
      const token = j2.access_token || j1.access_token;
      const expira = new Date(Date.now() + (j2.expires_in || 3600) * 1000).toISOString();
      // 3) perfil
      const me = await graph("me", token, { fields: "user_id,username,name,profile_picture_url,followers_count,follows_count,media_count,biography" });
      const id = String(me.user_id || me.id);
      const db = admin();
      await db.from("ig_contas").upsert({
        id, username: me.username, nome: me.name, foto: me.profile_picture_url, biografia: me.biography,
        seguidores: me.followers_count, seguindo: me.follows_count, midias: me.media_count,
        ativo: true, conectado_em: new Date().toISOString(), token_expira: expira, erro_sync: null,
      });
      await db.from("ig_tokens").upsert({ conta_id: id, access_token: token, expira_em: expira, permissoes: (j1.permissions || []) as string[], atualizado_em: new Date().toISOString() });
      // 4) assina webhooks de comentários e mensagens
      let webhook_ok = false;
      try {
        await graphPost(`${id}/subscribed_apps`, token, { subscribed_fields: "comments,messages,message_reactions,messaging_postbacks,messaging_seen" });
        webhook_ok = true;
      } catch (e) { await log("erro", id, { onde: "subscribed_apps", erro: String(e) }); }
      await db.from("ig_contas").update({ webhook_ok }).eq("id", id);
      await log("auth", id, { username: me.username, expira, webhook_ok });
      // 5) dispara o primeiro sync em segundo plano
      fetch(`${SUPABASE_URL}/functions/v1/ig-api/sync`, { method: "POST", headers: { "x-cron": CRON_SECRET, "Content-Type": "application/json" }, body: JSON.stringify({ conta_id: id, completo: true }) }).catch(() => {});
      return Response.redirect(`${APP_URL}/?conectado=${encodeURIComponent(me.username)}`, 302);
    } catch (e) {
      await log("erro", null, { onde: "callback", erro: String(e) });
      return html(pagina(`Não consegui concluir a conexão: ${String(e)}`), 500);
    }
  }

  if (rota === "/refresh" && req.method === "POST") {
    if (req.headers.get("x-cron") !== CRON_SECRET) return json({ erro: "não autorizado" }, 401);
    const { conta_id } = await req.json().catch(() => ({}));
    const db = admin();
    const contas = conta_id ? [conta_id] : (await db.from("ig_contas").select("id").eq("ativo", true)).data?.map((c) => c.id) || [];
    const out: Record<string, string> = {};
    for (const id of contas) {
      try {
        const tok = await tokenDaConta(id);
        if (!tok) { out[id] = "sem token"; continue; }
        const r = await fetch(`https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${tok}`);
        const j = await r.json();
        if (!j.access_token) throw new Error(JSON.stringify(j));
        const expira = new Date(Date.now() + (j.expires_in || 5184000) * 1000).toISOString();
        await db.from("ig_tokens").update({ access_token: j.access_token, expira_em: expira, atualizado_em: new Date().toISOString() }).eq("conta_id", id);
        await db.from("ig_contas").update({ token_expira: expira }).eq("id", id);
        out[id] = "ok até " + expira.slice(0, 10);
      } catch (e) { out[id] = String(e); await log("erro", id, { onde: "refresh", erro: String(e) }); }
    }
    return json(out);
  }

  return json({ ok: true, rotas: ["/start?u=email", "/callback", "POST /refresh"], redirect_uri: REDIRECT });
});

function pagina(msg: string) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="font-family:-apple-system,system-ui;background:#0f1a33;color:#fff;display:grid;place-items:center;height:100vh;margin:0"><div style="max-width:420px;padding:32px;text-align:center"><div style="font-size:40px">⚠️</div><h2 style="margin:12px 0">Lidera Social</h2><p style="opacity:.85;line-height:1.5">${msg}</p><a href="${APP_URL}" style="color:#A48A57">Voltar ao app</a></div></body>`;
}
