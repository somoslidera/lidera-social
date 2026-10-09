# Lidera Social

App de Instagram da Lidera (Charles + @somos.lidera): métricas, direct, comentários, leads e a rotina do Playbook de Social Selling PLL v2.

- Front: `index.html` (HTML único, Supabase JS). Publicado na Vercel.
- Backend: Edge Functions `ig-auth`, `ig-webhook`, `ig-api` no projeto Supabase `flow` (fvcbxorfstqqeewocxkf). Fonte em `supabase/functions/` na pasta Ágil Disc.
- Banco: tabelas `ig_*` (schema em `supabase/ig-setup.sql`).
- API da Meta: Instagram API with Instagram Login (graph.instagram.com). Modo assistido para seguir/curtir/comentar: o app monta a fila, a pessoa executa pelo celular.
