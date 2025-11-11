const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const dayjs = require('dayjs');

const PERIOD_CONFIG = {
  mensal: { label: 'Mensal', size: 1 },
  bimestral: { label: 'Bimestral', size: 2 },
  semestral: { label: 'Semestral', size: 6 }
};

const MONTH_ABBR = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    csv: 'planilha-custos-automated-download.csv',
    out: 'relatorio_financeiro.html',
    period: 'mensal',
    payment: 'all'
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--csv' && args[i + 1]) out.csv = args[++i];
    else if (a === '--out' && args[i + 1]) out.out = args[++i];
    else if (a === '--period' && args[i + 1]) out.period = args[++i].toLowerCase();
    else if (a === '--payment' && args[i + 1]) out.payment = args[++i];
  }
  if (!PERIOD_CONFIG[out.period]) {
    throw new Error(`Período inválido "${out.period}". Valores aceitos: ${Object.keys(PERIOD_CONFIG).join(', ')}`);
  }
  if (!out.payment) out.payment = 'all';
  return out;
}

function normalizeHeader(h) {
  return String(h || '').trim().replace(/\s+/g, '_');
}

function loadCSV(csvPath) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const parsed = Papa.parse(raw, { header: true, skipEmptyLines: true });
  if (parsed.errors && parsed.errors.length) {
    throw new Error('Erro ao ler CSV: ' + parsed.errors[0].message);
  }
  const cols = parsed.meta.fields.map(normalizeHeader);
  const rows = parsed.data.map((r) => {
    const obj = {};
    parsed.meta.fields.forEach((orig, idx) => {
      obj[cols[idx]] = r[orig];
    });
    return obj;
  });
  return { cols, rows };
}

function pick(dfCols, options) {
  for (const opt of options) {
    const n = normalizeHeader(opt);
    if (dfCols.includes(n)) return n;
  }
  return null;
}

function loadData(csvPath) {
  const { cols, rows } = loadCSV(csvPath);
  const colMapOpts = {
    id: ['ID_Lancamento', 'ID', 'Id'],
    data: ['Data', 'date'],
    descricao: ['Descricao', 'Descrição', 'Service', 'Servico'],
    categoria: ['Categoria', 'Tipo'],
    valor: ['Valor (R$)', 'Valor', 'Valor R$', 'Valor  R$ '],
    forma_pagto: ['Forma_de_Pagamento', 'FormaPagamento', 'Pagamento'],
    status: ['Status'],
    mes_ano: ['Mês/Ano', 'Mes/Ano', 'Mes_Ano', 'MesAno', 'Mês/Ano_'],
    ganhos: ['Ganhos'],
    gastos: ['Gastos']
  };

  const colsFound = Object.fromEntries(
    Object.entries(colMapOpts).map(([k, opts]) => [k, pick(cols, opts)])
  );

  if (!colsFound.data) throw new Error("Coluna de data não encontrada (ex.: 'Data').");

  let valorCol = colsFound.valor;
  if (!valorCol) {
    const candidates = cols.filter((c) => /valor/i.test(c));
    if (!candidates.length) throw new Error("Coluna de valor não encontrada (ex.: 'Valor (R$)').");
    valorCol = candidates[0];
  }

  const df = rows
    .map((r) => {
      const d = dayjs(r[colsFound.data]);
      if (!d.isValid()) return null;
      const valor = parseFloat(String(r[valorCol]).replace(',', '.'));
      return {
        data: d.toDate(),
        valor: isNaN(valor) ? 0 : valor,
        descricao: colsFound.descricao ? String(r[colsFound.descricao] || '').trim() : '',
        categoria: colsFound.categoria ? String(r[colsFound.categoria] || '').trim() : '',
        forma_pagto: colsFound.forma_pagto ? String(r[colsFound.forma_pagto] || '').trim() : '',
        status: colsFound.status ? String(r[colsFound.status] || '').trim() : ''
      };
    })
    .filter(Boolean);

  function inferTipo(row) {
    const cat = (row.categoria || '').toLowerCase();
    if (cat.startsWith('receita')) return 'Receita';
    if (cat.startsWith('despesa')) return 'Despesa';
    return row.valor >= 0 ? 'Receita' : 'Despesa';
  }

  df.forEach((r) => {
    r.tipo = inferTipo(r);
    r.valor_abs = Math.abs(r.valor);
    r.ano = r.data.getFullYear();
    r.mes = r.data.getMonth() + 1;
    r.mes_nome = `${MONTH_ABBR[r.mes - 1]}/${String(r.ano).slice(-2)}`;
  });

  return df;
}

function groupBy(arr, keyFn) {
  return arr.reduce((acc, item) => {
    const k = keyFn(item);
    (acc[k] = acc[k] || []).push(item);
    return acc;
  }, {});
}

function sum(arr, sel) {
  return arr.reduce((s, x) => s + sel(x), 0);
}

function normalizeFormaPagto(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function filterByPayment(df, paymentRaw) {
  if (!paymentRaw || normalizeFormaPagto(paymentRaw) === 'all') {
    return { rows: df, labels: [] };
  }

  const requested = paymentRaw
    .split(',')
    .map(normalizeFormaPagto)
    .filter(Boolean);

  if (!requested.length) {
    return { rows: df, labels: [] };
  }

  const filtered = df.filter((row) => {
    const norm = normalizeFormaPagto(row.forma_pagto);
    if (!norm) return false;
    return requested.some((req) => norm.includes(req));
  });

  if (!filtered.length) {
    throw new Error(
      `Nenhuma transação encontrada para forma de pagamento: ${paymentRaw}`
    );
  }

  const labels = Array.from(new Set(filtered.map((row) => row.forma_pagto || 'Indefinido')));

  return { rows: filtered, labels };
}

function buildPeriodSeries(df, periodCfg) {
  const groups = {};
  const size = periodCfg.size;

  df.forEach((row) => {
    const monthIndex = row.mes - 1;
    const bucketIndex = Math.floor(monthIndex / size);
    const startMonthIndex = bucketIndex * size;
    const endMonthIndex = Math.min(startMonthIndex + size - 1, 11);
    const key = `${row.ano}-${bucketIndex}`;

    if (!groups[key]) {
      groups[key] = {
        ano: row.ano,
        bucketIndex,
        startMonthIndex,
        endMonthIndex,
        rows: []
      };
    }

    groups[key].rows.push(row);
  });

  return Object.values(groups)
    .map((group) => {
      const receitas = group.rows.filter((r) => r.tipo === 'Receita');
      const despesas = group.rows.filter((r) => r.tipo === 'Despesa');
      const receita = sum(receitas, (x) => x.valor);
      const despesa = sum(despesas, (x) => -x.valor);
      const anoCurto = String(group.ano).slice(-2);
      const label = periodCfg.size === 1
        ? (group.rows[0]?.mes_nome ?? `${MONTH_ABBR[group.startMonthIndex]}/${anoCurto}`)
        : `${MONTH_ABBR[group.startMonthIndex]}/${anoCurto} - ${MONTH_ABBR[group.endMonthIndex]}/${anoCurto}`;

      return {
        ano: group.ano,
        indice: group.bucketIndex,
        label,
        receita,
        despesa,
        saldo: receita - despesa
      };
    })
    .sort((a, b) => a.ano - b.ano || a.indice - b.indice);
}

function computeKPIs(df, periodSlug = 'mensal') {
  const receitas = df.filter((r) => r.tipo === 'Receita');
  const despesas = df.filter((r) => r.tipo === 'Despesa');
  const total_receita = sum(receitas, (x) => x.valor);
  const total_despesa = sum(despesas, (x) => -x.valor);
  const resultado = total_receita - total_despesa;

  const periodKey = PERIOD_CONFIG[periodSlug] ? periodSlug : 'mensal';
  const periodCfg = PERIOD_CONFIG[periodKey];
  const periodos = buildPeriodSeries(df, periodCfg);

  return {
    total_receita,
    total_despesa,
    resultado,
    periodos,
    periodo: { slug: periodKey, label: periodCfg.label, tamanho: periodCfg.size }
  };
}

function buildFiguresData(df, kpis) {
  const figs = {};

  // 1. Séries por período
  figs.periodos = {
    x: kpis.periodos.map((m) => m.label),
    receita: kpis.periodos.map((m) => m.receita),
    despesa: kpis.periodos.map((m) => m.despesa),
    saldo: kpis.periodos.map((m) => m.saldo)
  };

  // 2. Receita por serviço (descricao)
  const recServ = Object.entries(groupBy(df.filter((r) => r.tipo === 'Receita'), (r) => r.descricao || 'Sem descrição'))
    .map(([desc, items]) => ({ descricao: desc, valor: sum(items, (x) => x.valor) }))
    .sort((a, b) => b.valor - a.valor);
  figs.receita_por_servico = recServ;

  // 3. (Removido) Despesas por categoria

  // 4. Formas de pagamento
  const frmRec = Object.entries(groupBy(df.filter((r) => r.tipo === 'Receita'), (r) => r.forma_pagto || 'Indefinido'))
    .map(([fp, items]) => ({ forma_pagto: fp, valor: sum(items, (x) => x.valor) }))
    .sort((a, b) => b.valor - a.valor);
  const frmDesp = Object.entries(groupBy(df.filter((r) => r.tipo === 'Despesa'), (r) => r.forma_pagto || 'Indefinido'))
    .map(([fp, items]) => ({ forma_pagto: fp, valor_abs: sum(items, (x) => x.valor_abs) }))
    .sort((a, b) => b.valor_abs - a.valor_abs);
  figs.pagto_receita = frmRec;
  figs.pagto_despesa = frmDesp;

  // 5. Status
  const status = Object.entries(groupBy(df, (r) => `${r.status || 'Sem status'}|${r.tipo}`))
    .map(([k, items]) => {
      const [status, tipo] = k.split('|');
      return { status, tipo, qtd: items.length };
    });
  figs.status = status;

  // 6. Top despesas
  const topDespesas = df
    .filter((r) => r.tipo === 'Despesa')
    .map((r) => ({ label: `${r.descricao || r.categoria || 'Despesa'} - ${dayjs(r.data).format('DD/MM/YYYY')}`, valor_abs: r.valor_abs }))
    .sort((a, b) => b.valor_abs - a.valor_abs)
    .slice(0, 15);
  figs.top_despesas = topDespesas;

  return figs;
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function buildHTML(df, kpis, figs, outputPath, sourceName, filters = {}) {
  const resumoItems = [
    `<li><strong>Receita Total:</strong> R$ ${kpis.total_receita.toFixed(2)}</li>`,
    `<li><strong>Despesas Totais:</strong> R$ ${kpis.total_despesa.toFixed(2)}</li>`,
    `<li><strong>Resultado:</strong> <strong style="color:${kpis.resultado >= 0 ? 'green' : 'red'}">R$ ${kpis.resultado.toFixed(2)}</strong></li>`,
    `<li><strong>Agrupamento:</strong> ${kpis.periodo.label}</li>`
  ];

  if (filters.payment && filters.payment.length) {
    const paymentsText = filters.payment.map((p) => htmlEscape(p)).join(', ');
    resumoItems.push(`<li><strong>Forma de Pagamento:</strong> ${paymentsText}</li>`);
  }

  resumoItems.push(
    `<li><strong>Período:</strong> ${dayjs(df[0].data).format('DD/MM/YYYY')} a ${dayjs(df[df.length - 1].data).format('DD/MM/YYYY')}</li>`,
    `<li><strong>Transações:</strong> ${df.length}</li>`
  );

  const resumoList = `<ul>${resumoItems.join('')}</ul>`;

  const tabelaTitulo = `Balanço ${kpis.periodo.label}`;

  // Tabela por período
  const periodoRows = kpis.periodos
    .map(
      (m) => `<tr><td>${htmlEscape(m.label)}</td><td>R$ ${m.receita.toFixed(2)}</td><td>R$ ${m.despesa.toFixed(2)}</td><td>R$ ${m.saldo.toFixed(2)}</td></tr>`
    )
    .join('');
  const periodoTable = `<table><thead><tr><th>Período</th><th>Receita</th><th>Despesa</th><th>Saldo</th></tr></thead><tbody>${periodoRows}</tbody></table>`;

  // Dados JS para gráficos
  const dataScript = `
    const figs = ${JSON.stringify(figs)};
    const periodos = ${JSON.stringify(kpis.periodos)};
    const periodoInfo = ${JSON.stringify(kpis.periodo)};
  `;

  const chartsScript = `
    // Série temporal por período
    Plotly.newPlot('fig_mensal', [
      { x: periodos.map(m=>m.label), y: periodos.map(m=>m.receita), type: 'bar', name: 'Receita', marker: {color: '#16a34a'} },
      { x: periodos.map(m=>m.label), y: periodos.map(m=>m.despesa), type: 'bar', name: 'Despesa', marker: {color: '#dc2626'} },
      { x: periodos.map(m=>m.label), y: periodos.map(m=>m.saldo), type: 'scatter', mode: 'lines+markers', name: 'Saldo', line: {color: '#0ea5e9', width: 3} }
    ], { title: 'Receitas, Despesas e Saldo (' + periodoInfo.label + ')', barmode: 'group' }, {responsive: true});

    // Receita por serviço
    Plotly.newPlot('fig_receita_serv', [{
      x: figs.receita_por_servico.map(r=>r.descricao), y: figs.receita_por_servico.map(r=>r.valor), type: 'bar', marker:{color:'#22c55e'}
    }], { title: 'Receita por Serviço', xaxis:{title:'Serviço'}, yaxis:{title:'Receita (R$)'} }, {responsive:true});

    // Formas de pagamento - Receita
    Plotly.newPlot('fig_pagto_rec', [{
      labels: figs.pagto_receita.map(r=>r.forma_pagto), values: figs.pagto_receita.map(r=>r.valor), type: 'pie'
    }], { title: 'Receitas por Forma de Pagamento' }, {responsive:true});

    // Formas de pagamento - Despesa
    Plotly.newPlot('fig_pagto_desp', [{
      labels: figs.pagto_despesa.map(r=>r.forma_pagto), values: figs.pagto_despesa.map(r=>r.valor_abs), type: 'pie'
    }], { title: 'Despesas por Forma de Pagamento' }, {responsive:true});

    // Status
    Plotly.newPlot('fig_status', [{
      x: figs.status.map(r=>r.status), y: figs.status.map(r=>r.qtd), type: 'bar', marker:{color:'#3b82f6'}, text: figs.status.map(r=>r.tipo), hovertemplate:'%{x}<br>Qtd: %{y}<br>Tipo: %{text}<extra></extra>'
    }], { title: 'Transações por Status', xaxis:{title:'Status'}, yaxis:{title:'Quantidade'} }, {responsive:true});

    // Top despesas
    Plotly.newPlot('fig_top_desp', [{
      x: figs.top_despesas.map(r=>r.label), y: figs.top_despesas.map(r=>r.valor_abs), type: 'bar', marker:{color:'#f87171'}
    }], { title: 'Top 15 Despesas Individuais', xaxis:{title:'Despesa'}, yaxis:{title:'Valor (R$)'} }, {responsive:true});
  `;

  const html = `<!doctype html>
  <html lang="pt-BR">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Relatório Financeiro</title>
      <script src="https://cdn.plot.ly/plotly-latest.min.js"></script>
      <script src="https://cdn.tailwindcss.com"></script>
      <style>
        .figure { width: 100%; height: 440px; }
      </style>
    </head>
    <body class="bg-gray-50 text-gray-800">
      <div class="max-w-6xl mx-auto p-6">
        <h1 class="text-2xl font-bold mb-2">Relatório Financeiro - Análise da Planilha</h1>
        <p class="text-sm"><strong>Arquivo:</strong> ${htmlEscape(sourceName)}</p>
        <p class="text-sm mb-4"><strong>Gerado em:</strong> ${dayjs().format('DD/MM/YYYY HH:mm')}</p>

        <div class="bg-white border border-gray-200 rounded-xl p-4 mb-4 shadow-sm">
          <h2 class="text-xl font-semibold mb-2">Resumo</h2>
          ${resumoList}
          <h3 class="text-lg font-medium mt-4">${tabelaTitulo}</h3>
          ${periodoTable}
        </div>

        <div class="bg-white border border-gray-200 rounded-xl p-4 shadow-sm">
          <h2 class="text-xl font-semibold mb-4">Gráficos</h2>
          <div id="fig_mensal" class="figure"></div>
          <div id="fig_receita_serv" class="figure"></div>
          <div id="fig_pagto_rec" class="figure"></div>
          <div id="fig_pagto_desp" class="figure"></div>
          <div id="fig_status" class="figure"></div>
          <div id="fig_top_desp" class="figure"></div>
        </div>
      </div>
    </body>
  </html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

function main() {
  const args = parseArgs();
  let csvPath = args.csv;
  if (!path.isAbsolute(csvPath)) csvPath = path.join(__dirname, csvPath);
  let outPath = args.out;
  if (!path.isAbsolute(outPath)) outPath = path.join(__dirname, outPath);

  const df = loadData(csvPath);
  if (!df.length) throw new Error('Nenhuma linha válida encontrada no CSV.');

  const paymentFilter = filterByPayment(df, args.payment);
  const filteredDf = paymentFilter.rows;
  if (!filteredDf.length) throw new Error('Nenhuma transação disponível após aplicar os filtros.');

  const kpis = computeKPIs(filteredDf, args.period);
  const figs = buildFiguresData(filteredDf, kpis);

  const filters = {};
  if (paymentFilter.labels.length) filters.payment = paymentFilter.labels;

  buildHTML(filteredDf, kpis, figs, outPath, path.basename(csvPath), filters);
  console.log('Relatório gerado:', outPath);
}

if (require.main === module) {
  main();
}
