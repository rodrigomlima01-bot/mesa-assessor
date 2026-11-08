// Atualiza o Radar da Mesa do Assessor.
// 1) busca Selic, CDI, IPCA e dólar no Banco Central
// 2) lê os feeds RSS de fontes.json (só manchetes, trecho e link)
// 3) pede ao Claude um resumo em palavras próprias, no formato do app
// 4) junta com o calendário de manual.json e grava dados.json
// Roda no GitHub Actions com Node 20 ou mais novo. A chave fica no segredo ANTHROPIC_API_KEY.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const arq = (nome) => path.join(DIR, nome);
const MODELO = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const REGIOES = ['Brasil', 'EUA', 'China', 'Europa'];
const IMPACTOS = ['Renda fixa', 'Bolsa', 'Dólar'];
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const ROTULOS_TAXAS = ['Selic', 'CDI', 'IPCA em 12 meses', 'Dólar'];

const log = (...a) => console.log(...a);
const fmt = (n, casas = 2) => n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
const dataBR = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
const mesAno = (dmy) => dmy.split('/').slice(1).join('/');

async function lerJSON(nome, padrao) {
  try { return JSON.parse(await readFile(arq(nome), 'utf8')); } catch { return padrao; }
}

async function baixar(url, opcoes = {}, tentativas = 2) {
  const { timeout = 25000, headers = {}, ...resto } = opcoes;
  let ultimo;
  for (let i = 0; i < tentativas; i++) {
    try {
      const r = await fetch(url, {
        ...resto,
        signal: AbortSignal.timeout(timeout),
        headers: { 'user-agent': 'MesaDoAssessor/1.0 (uso pessoal)', ...headers },
      });
      if (!r.ok) {
        const corpo = (await r.text().catch(() => '')).slice(0, 200);
        throw new Error(`HTTP ${r.status} ${corpo}`.trim());
      }
      return r;
    } catch (e) { ultimo = e; }
  }
  throw ultimo;
}

/* ---------- 1) taxas do Banco Central ---------- */
async function buscarTaxas(series, problemas) {
  const out = {};
  for (const [nome, codigo] of Object.entries(series || {})) {
    try {
      const r = await baixar(`https://api.bcb.gov.br/dados/serie/bcdata.sgs.${codigo}/dados/ultimos/1?formato=json`);
      const ultimo = (await r.json())[0];
      const valor = parseFloat(String(ultimo.valor).replace(',', '.'));
      if (!isFinite(valor)) throw new Error('valor inválido');
      out[nome] = { valor, data: ultimo.data };
    } catch (e) { problemas.push(`Banco Central (${nome}): ${e.message}`); }
  }
  return out;
}

function linhasDeTaxas(t, anterior) {
  const novas = [];
  if (t.selic) novas.push({ l: 'Selic', v: `${fmt(t.selic.valor)}% a.a.`, d: `meta, dado de ${t.selic.data}` });
  if (t.cdi) novas.push({ l: 'CDI', v: `${fmt(t.cdi.valor)}% a.a.`, d: `dado de ${t.cdi.data}` });
  if (t.ipca12m) novas.push({ l: 'IPCA em 12 meses', v: `${fmt(t.ipca12m.valor)}%`, d: `IBGE, referência ${mesAno(t.ipca12m.data)}` });
  if (t.dolar) novas.push({ l: 'Dólar', v: `R$ ${fmt(t.dolar.valor)}`, d: `PTAX de ${t.dolar.data}` });
  // se uma taxa falhar, mantém a linha anterior em vez de sumir
  for (const rotulo of ROTULOS_TAXAS) {
    if (!novas.find((x) => x.l === rotulo)) {
      const velha = (anterior.ref || []).find((x) => x.l === rotulo);
      if (velha) novas.push(velha);
    }
  }
  return novas.sort((a, b) => ROTULOS_TAXAS.indexOf(a.l) - ROTULOS_TAXAS.indexOf(b.l));
}

/* ---------- 2) feeds RSS ---------- */
const limpar = (s) => String(s)
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&(amp|lt|gt|quot|apos|#39|nbsp);/g, (m, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' }[c]))
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(+n))
  .replace(/<[^>]+>/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

export function lerFeed(xml, fonte) {
  const itens = [];
  const blocos = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of blocos) {
    const campo = (tag) => {
      const m = b.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i'));
      return m ? limpar(m[1]) : '';
    };
    let link = campo('link');
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1] : ''; }
    const data = new Date(campo('pubDate') || campo('published') || campo('updated') || campo('dc:date'));
    const titulo = campo('title');
    const resumo = (campo('description') || campo('summary')).slice(0, 350);
    if (titulo && /^https?:\/\//.test(link) && !isNaN(data)) itens.push({ fonte, titulo, link, data, resumo });
  }
  return itens;
}

async function buscarManchetes(cfg, problemas) {
  const limite = Date.now() - (cfg.diasMaximos || 3) * 86400000;
  const todas = [];
  for (const f of cfg.feeds || []) {
    try {
      const xml = await (await baixar(f.url)).text();
      const itens = lerFeed(xml, f.nome)
        .filter((i) => i.data.getTime() >= limite)
        .sort((a, b) => b.data - a.data)
        .slice(0, cfg.itensPorFeed || 12);
      log(`${f.nome}: ${itens.length} manchetes recentes`);
      todas.push(...itens);
    } catch (e) { problemas.push(`Feed ${f.nome}: ${e.message}`); }
  }
  const vistos = new Set();
  return todas
    .filter((i) => (vistos.has(i.link) ? false : vistos.add(i.link)))
    .sort((a, b) => b.data - a.data)
    .slice(0, cfg.maxManchetes || 45);
}

/* ---------- 3) resumo pelo Claude ---------- */
function montarPrompt(itens, max) {
  const hoje = new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const lista = itens.map((i, n) => `[${n}] (${i.fonte}, ${dataBR(i.data)}) ${i.titulo}${i.resumo ? ' — ' + i.resumo : ''}`).join('\n');
  return `Você ajuda um assessor de investimentos brasileiro (ele não é analista nem gestor e atua sob regras de suitability e compliance) a se preparar para conversar com clientes. Hoje é ${hoje}. Abaixo estão manchetes recentes de portais de notícia, numeradas. Escolha até ${max} que mais impactam o mercado (juros, inflação, câmbio, bolsa, commodities), cobrindo Brasil, EUA, China e Europa quando houver material.

Regras:
- Use SOMENTE o que está nas manchetes e trechos. Não invente números, datas, causas ou citações. Se o trecho não traz um dado, não o inclua.
- Escreva com suas próprias palavras e não copie frases das matérias.
- Não recomende comprar ou vender ativo, não faça previsões e não prometa rentabilidade.
- Ignore esportes, política sem efeito econômico direto, celebridades e conteúdo promocional.
- Várias manchetes sobre o mesmo fato viram um único item, com todos os números no campo idx.

Responda APENAS com JSON neste formato, sem texto fora dele:
{"dest":["frase","frase","frase"],"news":[{"idx":[0],"r":"Brasil","s":3,"t":"título curto","f":"o que aconteceu","z":"o que dizer ao cliente","n":"o que não prometer","x":["Renda fixa","Bolsa","Dólar"],"post":"ideia de post"}]}

Campos: idx = números das manchetes usadas; r = Brasil, EUA, China ou Europa (se não couber em nenhuma, não inclua o item); s = importância de 1 a 3 (3 = mexe com juros, câmbio ou bolsa de forma ampla); t = título curto seu; f = o que aconteceu, 1 a 3 frases; z = o que o assessor pode dizer ao cliente, 1 a 2 frases simples; n = o que não prometer, 1 frase; x = lista com itens entre Renda fixa, Bolsa e Dólar; post = ideia de post em uma frase, só quando s for 3; dest = 3 frases curtas com os assuntos mais importantes para o assessor levar aos clientes.

MANCHETES
${lista}`;
}

async function pedirClaude(prompt) {
  const r = await baixar('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    timeout: 180000,
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({ model: MODELO, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
  }, 1);
  const j = await r.json();
  const texto = (j.content || []).map((c) => c.text || '').join('');
  const a = texto.indexOf('{'), b = texto.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('resposta sem JSON');
  return JSON.parse(texto.slice(a, b + 1));
}

export function montarNoticias(resp, itens, max) {
  const out = [];
  for (const n of resp.news || []) {
    const idx = [...new Set((n.idx || []).filter((i) => Number.isInteger(i) && itens[i]))];
    if (!idx.length || !REGIOES.includes(n.r) || !n.t || !n.f || !n.z || !n.n) continue;
    const s = Math.min(3, Math.max(1, parseInt(n.s, 10) || 1));
    out.push({
      r: n.r,
      s,
      dt: dataBR(itens[idx[0]].data),
      t: String(n.t),
      f: String(n.f),
      z: String(n.z),
      n: String(n.n),
      x: (n.x || []).filter((x) => IMPACTOS.includes(x)),
      post: s >= 3 && n.post ? String(n.post) : undefined,
      src: idx.slice(0, 3).map((i) => ({ n: itens[i].fonte, u: itens[i].link })),
    });
  }
  return out.sort((a, b) => b.s - a.s).slice(0, max);
}

/* ---------- 4) calendário manual ---------- */
export function montarCalendario(manual, agora = new Date()) {
  const f = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/Sao_Paulo' });
  const hoje = f.format(agora);
  const limite = f.format(new Date(agora.getTime() + 14 * 86400000));
  return (manual.cal || [])
    .filter((e) => e.data >= hoje && e.data <= limite)
    .sort((a, b) => (a.data + a.h).localeCompare(b.data + b.h))
    .map((e) => {
      const [y, m, d] = e.data.split('-').map(Number);
      const dia = DIAS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
      return { d: `${dia} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}`, h: e.h, p: e.p, e: e.e, s: e.s, a: e.a || '', w: e.w };
    });
}

/* ---------- principal ---------- */
export async function main() {
  const cfg = await lerJSON('fontes.json', {});
  const manual = await lerJSON('manual.json', { refExtra: [], cal: [] });
  const anterior = await lerJSON('dados.json', {});
  const problemas = [];

  const taxas = await buscarTaxas(cfg.bcb, problemas);
  const ref = [...linhasDeTaxas(taxas, anterior), ...(manual.refExtra || [])];
  const apply = { ...(anterior.apply || {}) };
  for (const k of ['selic', 'cdi', 'ipca', 'dolar']) {
    const origem = { selic: 'selic', cdi: 'cdi', ipca: 'ipca12m', dolar: 'dolar' }[k];
    if (taxas[origem]) apply[k] = taxas[origem].valor;
  }

  let news = anterior.news || [];
  let dest = anterior.dest || [];
  let updated = anterior.updated || new Date().toISOString();
  const max = cfg.maxNoticias || 10;

  if (!process.env.ANTHROPIC_API_KEY) {
    problemas.push('Segredo ANTHROPIC_API_KEY não encontrado. As notícias não foram atualizadas.');
  } else {
    const itens = await buscarManchetes(cfg, problemas);
    if (!itens.length) {
      problemas.push('Nenhuma manchete recente foi lida. As notícias não foram atualizadas.');
    } else {
      try {
        const resp = await pedirClaude(montarPrompt(itens, max));
        const novas = montarNoticias(resp, itens, max);
        if (!novas.length) throw new Error('o Claude não devolveu notícias válidas');
        news = novas;
        if (Array.isArray(resp.dest) && resp.dest.length) dest = resp.dest.slice(0, 3).map(String);
        updated = new Date().toISOString();
        log(`Notícias atualizadas: ${novas.length}`);
      } catch (e) { problemas.push(`Claude: ${e.message}`); }
    }
  }

  const dados = { updated, apply, ref, dest, cal: montarCalendario(manual), news };
  await writeFile(arq('dados.json'), JSON.stringify(dados, null, 2) + '\n');
  log('dados.json gravado.');
  if (problemas.length) {
    console.warn('Atenção:\n- ' + problemas.join('\n- '));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message); process.exit(1); });
}
