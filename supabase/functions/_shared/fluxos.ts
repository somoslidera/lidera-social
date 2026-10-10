// Fluxos de entrada do social selling, editáveis por conta na tabela ig_fluxos.
// Aqui ficam os padrões (playbook v2). Um passo:
//   { id, tipo: 'reciprocidade'|'comentar'|'mensagem'|'story', dia: N (dias depois do passo anterior de mensagem / da entrada),
//     titulo, texto (com [Nome], [restaurante], [conexao]), ia: true (a IA escreve a partir do texto como guia),
//     automatico: true (envia pela API oficial quando houver canal: resposta privada a comentário ou conversa aberta),
//     condicao: 'sempre' | 'sem_resposta' (só se o lead ainda não respondeu) }
export type Passo = { id: string; tipo: string; dia: number; titulo: string; texto?: string; ia?: boolean; automatico?: boolean; condicao?: string };
export type Fluxo = { codigo: string; nome: string; descricao: string; ativo: boolean; so_icp: boolean; passos: Passo[] };

const RECIP = (id: string): Passo => ({ id, tipo: "reciprocidade", dia: 0, titulo: "Reciprocidade: seguir, curtir 2 posts, reagir a 1 story", condicao: "sempre" });
const FUP2: Passo = { id: "fup2", tipo: "mensagem", dia: 2, titulo: "Follow-up D+2", condicao: "sem_resposta", texto: "[Nome], vi seus stories do movimento do fim de semana. Aproveitando, [repete a pergunta de outra forma]" };
const FUP5: Passo = { id: "fup5", tipo: "mensagem", dia: 3, titulo: "Follow-up D+5 (valor)", condicao: "sem_resposta", texto: "[Nome], lembrei de você. Gravei isso sobre [dor do nicho dele], acho que casa com a operação de vocês. Se quiser trocar ideia, é só chamar." };
const FUP10: Passo = { id: "fup10", tipo: "mensagem", dia: 5, titulo: "Follow-up D+10 (fecha com respeito)", condicao: "sem_resposta", texto: "[Nome], vou parar de te incomodar. Só deixo registrado: se em algum momento você quiser olhar os números do [restaurante] com alguém de fora, me chama aqui. Sucesso na operação!" };

export const FLUXOS_PADRAO: Fluxo[] = [
  { codigo: "SC", nome: "Story de captura", descricao: "Respondeu enquete, quiz ou caixinha. Já declarou a dor: responde na hora, pelo direct.", ativo: true, so_icp: false, passos: [
    { id: "sc1", tipo: "mensagem", dia: 0, titulo: "Resposta ao story de captura", ia: true, automatico: true, condicao: "sempre", texto: "[Nome], vi sua resposta ali. E olha, você tá em boa companhia, a maioria respondeu igual.\nFui conhecer o [restaurante] aqui e [conexao].\nTe pergunto: hoje o que mais te atrapalha pra ter esse número na mão? É falta de tempo, falta de organização dos dados, ou nunca alguém te mostrou como montar?" },
    FUP2, FUP5, FUP10 ] },
  { codigo: "RS", nome: "Reação ou resposta em story", descricao: "Levantou a mão sozinho. Inbound quente: responder em até 5 minutos.", ativo: true, so_icp: false, passos: [
    { id: "rs1", tipo: "mensagem", dia: 0, titulo: "Resposta à reação no story", ia: true, automatico: true, condicao: "sempre", texto: "Opa [Nome], bom [dia/tarde]! Valeu pela reação ali. Fui conhecer o [restaurante] e [conexao].\nEu tenho um Programa de Aceleração para Restaurantes focado na Gestão Financeira e Gestão de Pessoas.\n[pergunta factual]" },
    FUP2, FUP5, FUP10 ] },
  { codigo: "CP", nome: "Comentário ou curtida em post", descricao: "Primeiro responde em público agregando valor. Depois vai ao direct (resposta privada ao comentário, pela API oficial).", ativo: true, so_icp: true, passos: [
    { id: "cp0", tipo: "comentar", dia: 0, titulo: "Responder o comentário em público, agregando valor", ia: true, automatico: true, condicao: "sempre", texto: "1 a 2 linhas, nunca 'top!', pode terminar com pergunta curta." },
    RECIP("cp1"),
    { id: "cp2", tipo: "mensagem", dia: 0, titulo: "Abridor de direct (resposta privada ao comentário)", ia: true, automatico: true, condicao: "sempre", texto: "Opa [Nome], bom [dia/tarde]! Vi seu comentário no post e vim dar um oi pessoalmente. Fui conhecer o [restaurante] e [conexao].\nEu tenho um Programa de Aceleração para Restaurantes focado na Gestão Financeira e Gestão de Pessoas.\n[pergunta factual]" },
    FUP2, FUP5, FUP10 ] },
  { codigo: "NS", nome: "Novo seguidor", descricao: "Triagem de 60 s, reciprocidade e boas-vindas (12 modelos). Sem canal oficial para a 1ª mensagem: fica pronta na fila.", ativo: true, so_icp: true, passos: [
    RECIP("ns1"),
    { id: "ns2", tipo: "mensagem", dia: 0, titulo: "Boas-vindas (modelo escolhido pela IA)", ia: true, automatico: false, condicao: "sempre", texto: "Opa [Nome], bom [dia/tarde]! Tudo certo?\nVi que você começou a me acompanhar por aqui e eu faço questão de dar um oi pessoalmente pra quem chega. Fui conhecer o [restaurante] e [conexao].\nEu tenho um Programa de Aceleração para Restaurantes focado na Gestão Financeira e Gestão de Pessoas.\n[pergunta factual]" },
    FUP2, FUP5, FUP10 ] },
  { codigo: "VS", nome: "Visita sincera na base parada", descricao: "Frios há 60 dias, quem engajou e não foi abordado. Reaquecer antes de falar.", ativo: true, so_icp: true, passos: [
    { id: "vs1", tipo: "story", dia: 0, titulo: "Ver stories, reagir a 1, curtir o último post", condicao: "sempre" },
    { id: "vs2", tipo: "mensagem", dia: 1, titulo: "Reativação com gancho novo", ia: true, automatico: false, condicao: "sempre", texto: "[Nome], vi [gancho novo do perfil] e lembrei de você. [pergunta factual nova]" },
    FUP2, FUP5 ] },
  { codigo: "OB", nome: "Outbound ativo", descricao: "Aquecimento obrigatório de 2 dias antes da primeira mensagem.", ativo: true, so_icp: true, passos: [
    { id: "ob0", tipo: "reciprocidade", dia: 0, titulo: "Dia 0: seguir, curtir 3 posts, ver todos os stories e reagir a 1", condicao: "sempre" },
    { id: "ob1", tipo: "comentar", dia: 1, titulo: "Dia 1: comentar 1 post com comentário de valor (nunca 'top!')", ia: true, condicao: "sempre", texto: "ex.: esse mix de proteína no balcão é uma jogada boa pra puxar ticket" },
    { id: "ob2", tipo: "mensagem", dia: 1, titulo: "Dia 2: mensagem de ativação", ia: true, automatico: false, condicao: "sempre", texto: "Opa [Nome], bom [dia/tarde]! Tudo certo?\nFui conhecer o [restaurante] e [conexao].\nEu tenho um Programa de Aceleração para Restaurantes focado na Gestão Financeira e Gestão de Pessoas.\n[pergunta factual]" },
    FUP2, FUP5, FUP10 ] },
];

export const TIPO_PARA_ACAO: Record<string, string> = { reciprocidade: "seguir", comentar: "comentar", mensagem: "ativar", story: "reagir_story" };
export const BLOCO_POR_FLUXO: Record<string, number> = { SC: 2, RS: 2, CP: 2, NS: 4, VS: 7, OB: 8 };

export function preencher(texto: string, lead: Record<string, unknown>, saud: string): string {
  return (texto || "")
    .replace(/\[Nome\]/g, String(lead.nome || lead.username || ""))
    .replace(/\[restaurante\]/g, String(lead.restaurante || "restaurante"))
    .replace(/\[conexao\]/g, String(lead.conexao || "[conexão específica]"))
    .replace(/\[dia\/tarde\]/g, saud.replace("bom ", "").replace("boa ", ""));
}
export const temPlaceholder = (t: string) => /\[[^\]]+\]/.test(t || "");
