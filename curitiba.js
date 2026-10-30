// === CURITIBA (GeoCuritiba / IPPUC) ===
// Fontes públicas: cadastro de lotes, zoneamento, PGV, circunscrição imobiliária
// e transporte (URBS) do ArcGIS Server do IPPUC. Curitiba publica apenas o
// lote — unidades de condomínio e proprietário não são divulgados.

const GEOCURITIBA = 'https://geocuritiba.ippuc.org.br/server/rest/services/GeoCuritiba';
const CWB_LOTE = `${GEOCURITIBA}/Publico_GeoCuritiba_MapaCadastral/MapServer/15`;
const CWB_ZONEAMENTO = `${GEOCURITIBA}/Publico_GeoCuritiba_MapaCadastral/MapServer/36`;
const CWB_PGV = `${GEOCURITIBA}/Publico_GeoCuritiba_Planta_Generica_Valores/MapServer/0`;
const CWB_CIRCUNSCRICAO = `${GEOCURITIBA}/Publico_Interno_GeoCuritiba_BaseTematica/MapServer/15`;
const CWB_TERMINAL = `${GEOCURITIBA}/URBS_Transporte_Publico/MapServer/0`;
const CWB_PARADA = `${GEOCURITIBA}/URBS_Transporte_Publico/MapServer/1`;

// O cadastro de Curitiba grava o tipo de via por extenso ("AVENIDA SETE DE SETEMBRO")
const TIPO_VIA_CWB = {
  R: 'RUA', AV: 'AVENIDA', AL: 'ALAMEDA', TV: 'TRAVESSA', PC: 'PRAÇA',
  LGO: 'LARGO', ESTR: 'ESTRADA', PQ: 'PARQUE'
};

function ehCuritiba(endereco) {
  return /\bcuritiba\b/i.test(removerAcentos(endereco));
}

// Remove sufixos de cidade/UF ("..., Curitiba - PR", "Curitiba/PR") antes do parse
function limparCidadeCuritiba(endereco) {
  return endereco
    .replace(/[,\-–]?\s*curitiba\s*([\/\-–,]\s*(pr|parana|paraná))?\s*$/i, '')
    .replace(/[,\-–]\s*(pr|parana|paraná)\s*$/i, '')
    .trim();
}

// Os nomes do cadastro mantêm acentos ("RUA COMENDADOR ARAÚJO"); trocar vogais
// e C pelo curinga de um caractere torna o LIKE indiferente a acento/cedilha.
function curingaAcentos(nome) {
  return nome.replace(/[AEIOUC']/g, '_');
}

async function consultarArcGIS(layerUrl, params) {
  const qs = new URLSearchParams({ f: 'json', returnGeometry: 'false', outFields: '*', ...params });
  const resp = await fetch(`${layerUrl}/query?${qs}`);
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'Erro no GeoCuritiba');
  return data.features || [];
}

function pontoArcGIS(coord) {
  return {
    geometry: JSON.stringify({ x: coord.lon, y: coord.lat, spatialReference: { wkid: 4326 } }),
    geometryType: 'esriGeometryPoint',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects'
  };
}

function centroidArcGIS(geometry) {
  const ring = geometry?.rings?.[0];
  if (!ring || ring.length === 0) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of ring) { sx += x; sy += y; }
  return { lat: sy / ring.length, lon: sx / ring.length };
}

function escolherLote(features) {
  return features.find(f => f.attributes?.gtm_desc_situacao === 'Ativo') || features[0];
}

async function buscarLoteCuritiba(enderecoBase) {
  const { palavras, palavrasSemTitulo, numero, prefixo } = extrairLogradouroNumero(enderecoBase);
  if (!palavras || !numero) return null;

  const nomes = [...new Set([palavras, palavrasSemTitulo].filter(Boolean))].map(curingaAcentos);
  const tipo = prefixo && TIPO_VIA_CWB[prefixo] ? curingaAcentos(TIPO_VIA_CWB[prefixo]) : null;

  // Do mais preciso ao menos: ancorado no tipo de via, termina com o nome, contém o nome
  const patterns = [];
  if (tipo) for (const n of nomes) patterns.push(`${tipo} %${n}`);
  for (const n of nomes) patterns.push(`% ${n}`);
  for (const n of nomes) patterns.push(`%${n}%`);

  for (const pat of patterns) {
    try {
      const features = await consultarArcGIS(CWB_LOTE, {
        where: `gtm_nm_logradouro LIKE '${pat}' AND gtm_num_predial='${numero}'`,
        returnGeometry: 'true',
        outSR: '4326'
      });
      if (features.length > 0) {
        const f = escolherLote(features);
        return { attrs: f.attributes, centroid: centroidArcGIS(f.geometry), aproximado: false };
      }
    } catch (e) { /* tenta o próximo padrão */ }
  }

  // Número ausente do cadastro: estima pelo próprio lado da rua
  for (const pat of patterns) {
    try {
      const lotes = await consultarArcGIS(CWB_LOTE, {
        where: `gtm_nm_logradouro LIKE '${pat}'`,
        returnGeometry: 'true',
        outSR: '4326'
      });
      if (lotes.length > 0) return await estimarLotePorNumero(lotes, parseInt(numero, 10));
    } catch (e) { /* tenta o próximo padrão */ }
  }
  return null;
}

// Com o nº pedido fora do cadastro, usa o lote do mesmo lado (par/ímpar) com
// número mais próximo. Se o nº fica antes do primeiro ou depois do último
// desse lado, o imóvel costuma ser o lote de esquina vizinho, cadastrado pela
// rua transversal (ex: Sabina Lupinski nº 13 = esquina "Francisco das Chagas
// Lopes, 729", vizinha do nº 47).
async function estimarLotePorNumero(lotes, n) {
  const comNum = lotes
    .map(f => ({ f, num: parseInt(f.attributes.gtm_num_predial, 10), c: centroidArcGIS(f.geometry) }))
    .filter(x => !isNaN(x.num) && x.c);
  if (comNum.length === 0 || isNaN(n)) return null;
  const lado = comNum.filter(x => x.num % 2 === n % 2);
  const base = (lado.length ? lado : comNum).sort((a, b) => Math.abs(a.num - n) - Math.abs(b.num - n));
  const nearest = base[0];
  const nums = base.map(x => x.num);
  const foraDaFaixa = n < Math.min(...nums) || n > Math.max(...nums);

  if (foraDaFaixa && base.length > 1) {
    // Direção de avanço da numeração, do 2º mais próximo para o mais próximo
    const second = base[1];
    const dir = { x: nearest.c.lon - second.c.lon, y: nearest.c.lat - second.c.lat };
    const pad = 0.0002; // ~20 m
    const xs = nearest.f.geometry.rings[0].map(p => p[0]);
    const ys = nearest.f.geometry.rings[0].map(p => p[1]);
    try {
      const vizinhos = await consultarArcGIS(CWB_LOTE, {
        geometry: `${Math.min(...xs) - pad},${Math.min(...ys) - pad},${Math.max(...xs) + pad},${Math.max(...ys) + pad}`,
        geometryType: 'esriGeometryEnvelope',
        inSR: '4326',
        spatialRel: 'esriSpatialRelIntersects',
        returnGeometry: 'true',
        outSR: '4326'
      });
      const quadra = String(nearest.f.attributes.gtm_ind_fiscal || '').slice(0, 5);
      const esquinas = vizinhos
        .filter(v => /esquina/i.test(v.attributes.geo_desc_posicao_quadra || '')
          && String(v.attributes.gtm_ind_fiscal || '').slice(0, 5) === quadra
          && v.attributes.gtm_nm_logradouro !== nearest.f.attributes.gtm_nm_logradouro)
        .map(v => {
          const c = centroidArcGIS(v.geometry);
          return {
            v, c,
            score: c ? (c.lon - nearest.c.lon) * dir.x + (c.lat - nearest.c.lat) * dir.y : -Infinity,
            dist: c ? Math.hypot(c.lon - nearest.c.lon, c.lat - nearest.c.lat) : Infinity
          };
        })
        // à frente na direção da numeração, e a mais próxima do último lote
        .filter(e => e.score > 0)
        .sort((a, b) => a.dist - b.dist);
      if (esquinas.length > 0) {
        return { attrs: esquinas[0].v.attributes, centroid: esquinas[0].c, aproximado: true, motivo: 'esquina' };
      }
    } catch (e) { /* usa o vizinho mais próximo */ }
  }
  return { attrs: nearest.f.attributes, centroid: nearest.c, aproximado: true, motivo: 'vizinho' };
}

// Fallback: lote que contém (ou está a até 30 m de) o ponto geocodificado
async function buscarLoteCuritibaPorPonto(coord) {
  for (const extra of [{}, { distance: '30', units: 'esriSRUnit_Meter' }]) {
    const features = await consultarArcGIS(CWB_LOTE, {
      ...pontoArcGIS(coord), ...extra, returnGeometry: 'true', outSR: '4326'
    });
    if (features.length > 0) {
      const f = escolherLote(features);
      return { attrs: f.attributes, centroid: centroidArcGIS(f.geometry), aproximado: true, motivo: 'mapa' };
    }
  }
  return null;
}

async function geocodificarCuritiba(endereco) {
  const q = `${endereco}, Curitiba, PR, Brasil`;
  const resp = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q)}`,
    { headers: { 'User-Agent': 'ExtensaoImoveisSP/1.0' } }
  );
  const data = await resp.json();
  if (!data.length) throw new Error('Endereço não encontrado');
  return { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon), display_name: data[0].display_name };
}

// Verifica se o número cabe na faixa do complemento do ViaCEP
// ("de 1600/1601 a 2230/2231", "até 599/600", "de 601/602 ao fim", "lado ímpar")
function numeroNaFaixaCep(complemento, numero) {
  const c = removerAcentos(complemento || '').toLowerCase();
  const n = parseInt(numero, 10);
  if (!c || isNaN(n)) return true;
  if (/lado impar/.test(c) && n % 2 === 0) return false;
  if (/lado par/.test(c) && n % 2 === 1) return false;
  let m = c.match(/de (\d+)(?:\/\d+)? a (\d+)/);
  if (m) return n >= +m[1] && n <= +m[2];
  m = c.match(/ate (\d+)/);
  if (m) return n <= +m[1];
  m = c.match(/de (\d+)(?:\/\d+)? ao fim/);
  if (m) return n >= +m[1];
  return true;
}

async function buscarCepCuritiba(nomeLogradouro, numero, bairro) {
  if (!nomeLogradouro || nomeLogradouro.length < 3) return null;
  const resp = await fetch(`https://viacep.com.br/ws/PR/Curitiba/${encodeURIComponent(nomeLogradouro)}/json/`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) return null;
  const norm = s => removerAcentos(s || '').toUpperCase().trim();
  const doBairro = bairro ? data.filter(d => norm(d.bairro) === norm(bairro)) : [];
  const base = doBairro.length ? doBairro : data;
  return base.find(d => numeroNaFaixaCep(d.complemento, numero)) || base[0];
}

async function buscarZoneamentoCuritiba(coord, attrs) {
  let legislacao = 'Lei 15.511/2019';
  let zonaNome = attrs?.gtm_desc_grupo_zoneamento || null;
  let sigla = (attrs?.gtm_sigla_zoneamento || '').trim();
  try {
    const f = (await consultarArcGIS(CWB_ZONEAMENTO, pontoArcGIS(coord)))[0];
    if (f) {
      sigla = sigla || f.attributes.sg_zona;
      zonaNome = f.attributes.nm_zona || zonaNome;
      if (f.attributes.legislacao) legislacao = f.attributes.legislacao.replace(/\s+/g, ' ');
    }
  } catch (e) { /* usa os atributos do lote */ }
  return {
    zona: sigla ? `${sigla} - ${zonaNome || ''}`.replace(/ - $/, '') : (zonaNome || 'Não encontrado'),
    coefAprov: (attrs?.gtm_desc_abrangencia || '-').trim(),
    gabarito: legislacao
  };
}

async function buscarPGVCuritiba(coord) {
  const f = (await consultarArcGIS(CWB_PGV, pontoArcGIS(coord)))[0];
  return f?.attributes?.vukt ? parseFloat(f.attributes.vukt) : null;
}

async function buscarCircunscricaoCuritiba(coord) {
  const f = (await consultarArcGIS(CWB_CIRCUNSCRICAO, pontoArcGIS(coord)))[0];
  const circ = f?.attributes?.circunscricao;
  if (!circ) return { cartorio: '-', endereco: '-' };
  const texto = circ.charAt(0) + circ.slice(1).toLowerCase().replace('circunscrição', 'Circunscrição');
  return { cartorio: `${texto} do Registro de Imóveis de Curitiba`, endereco: '-' };
}

function formatarDistancia(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} metros`;
}

async function buscarTransporteCuritiba(coord) {
  const result = { metroProximo: '-', metroDistancia: '-', tremProximo: '-', tremDistancia: '-' };
  const d = 0.03; // ~3 km
  const [terminais, tubos] = await Promise.allSettled([
    consultarArcGIS(CWB_TERMINAL, { where: '1=1', outFields: 'nome_completo,nome_rua,num_pred', returnGeometry: 'true', outSR: '4326' }),
    consultarArcGIS(CWB_PARADA, {
      where: "tipo='Estação tubo'",
      outFields: 'nome_ponto,lat,lon',
      geometry: `${coord.lon - d},${coord.lat - d},${coord.lon + d},${coord.lat + d}`,
      geometryType: 'esriGeometryEnvelope',
      inSR: '4326',
      spatialRel: 'esriSpatialRelIntersects'
    })
  ]);

  const maisProximo = (itens, pos) => {
    let best = null, min = Infinity;
    for (const it of itens) {
      const p = pos(it);
      if (!p) continue;
      const dist = calcularDistancia(coord.lat, coord.lon, p.lat, p.lon);
      if (dist < min) { min = dist; best = it; }
    }
    return best ? { item: best, dist: min } : null;
  };

  if (terminais.status === 'fulfilled') {
    const t = maisProximo(terminais.value, f => f.geometry ? { lat: f.geometry.y, lon: f.geometry.x } : null);
    if (t) {
      result.metroProximo = t.item.attributes.nome_completo;
      result.metroDistancia = formatarDistancia(t.dist);
    }
  } else {
    result.metroProximo = `Erro: ${terminais.reason?.message}`;
  }

  if (tubos.status === 'fulfilled') {
    const e = maisProximo(tubos.value, f => ({ lat: f.attributes.lat, lon: f.attributes.lon }));
    if (e) {
      result.tremProximo = e.item.attributes.nome_ponto;
      result.tremDistancia = formatarDistancia(e.dist);
    } else {
      result.tremProximo = 'Nenhuma estação-tubo em ~3 km';
    }
  } else {
    result.tremProximo = `Erro: ${tubos.reason?.message}`;
  }
  return result;
}

function formatarReais(v) {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function buscarDadosCuritiba(endereco) {
  const enderecoSemCidade = limparCidadeCuritiba(endereco);
  const complemento = parseComplemento(enderecoSemCidade);
  const enderecoBase = stripComplemento(enderecoSemCidade);
  const { numero } = extrairLogradouroNumero(enderecoBase);

  // 1. Lote por nome + número; fallback pela posição geocodificada
  let lote = await buscarLoteCuritiba(enderecoBase).catch(() => null);
  let geo = null;
  if (!lote) {
    geo = await geocodificarCuritiba(enderecoBase).catch(() => null);
    if (geo) lote = await buscarLoteCuritibaPorPonto(geo).catch(() => null);
  }
  if (!lote && !geo) {
    throw new Error(
      `Não foi possível localizar "${enderecoBase}" em Curitiba. Verifique a grafia da rua e o número.`
    );
  }

  const a = lote?.attrs || {};
  const coord = lote?.centroid || geo;
  const nomeRua = a.gtm_nm_logradouro || enderecoBase.split(',')[0].trim();
  const bairroLote = a.gtm_nm_bairro || null;

  // 2. Dados espaciais em paralelo
  const [zon, pgv, circ, transp, cep, pois] = await Promise.allSettled([
    buscarZoneamentoCuritiba(coord, a),
    buscarPGVCuritiba(coord),
    buscarCircunscricaoCuritiba(coord),
    buscarTransporteCuritiba(coord),
    buscarCepCuritiba(removerAcentos(nomeRua).replace(/^(RUA|AVENIDA|ALAMEDA|TRAVESSA|PRACA|LARGO|ESTRADA)\s+/i, ''), numero, bairroLote),
    buscarPOIsGoogle(coord)
  ]);
  const val = r => (r.status === 'fulfilled' ? r.value : null);

  const indicacaoFiscal = a.gtm_ind_fiscal || '-';
  const especie = a.gtm_desc_especie || '';
  const isCondominio = /condom|subeconomia|parte ideal/i.test(especie);
  const area = a.gtm_mtr_area_terreno != null ? parseFloat(a.gtm_mtr_area_terreno) : null;
  const vukt = val(pgv);
  const cepData = val(cep);
  const cartorio = val(circ) || { cartorio: '-', endereco: '-' };

  let valorVenal = 'Consulte pela Indicação Fiscal no portal da Prefeitura de Curitiba';
  if (vukt && area) {
    valorVenal = `Terreno pela PGV 2025: ${formatarReais(vukt * area)} `
      + `(${area.toLocaleString('pt-BR')} m² × ${formatarReais(vukt)}/m²). `
      + 'Estimativa — o valor venal oficial aplica fatores de correção.';
  }

  let matricula = { matricula: '-', fonte: '' };
  if (indicacaoFiscal !== '-') {
    const cached = await getCachedMatricula(`matricula_cwb_${indicacaoFiscal}`);
    if (cached) matricula = { matricula: cached.matricula, fonte: 'cache local' };
  }

  const enderecoOficial = a.gtm_nm_logradouro
    ? `${a.gtm_nm_logradouro}, ${a.gtm_num_predial} - ${bairroLote || ''}, Curitiba/PR`
    : (geo?.display_name || endereco);

  return {
    cidade: 'curitiba',
    coordenadas: { lat: coord.lat, lon: coord.lon, display_name: enderecoOficial },
    geoSampa: {
      sql: indicacaoFiscal,
      aproximado: !!lote?.aproximado,
      motivo: lote?.motivo || null,
      numeroPedido: numero || null,
      numeroLote: a.gtm_num_predial || null,
      cep: cepData?.cep || '-',
      bairro: bairroLote || cepData?.bairro || '-',
      distrito: a.gtm_insc_imob || '-',
      isCondominio,
      especie,
      complemento
    },
    iptu: {
      valorVenal,
      areaTerreno: area != null ? `${area.toFixed(2)} m²` : '-',
      areaConstruida: 'Não divulgada no cadastro público',
      anoConstrucao: '-',
      tipoUso: [a.gtm_desc_natureza, especie].filter(Boolean).join(' — ') || '-'
    },
    proprietario: {
      proprietario: 'Não divulgado publicamente pela Prefeitura de Curitiba',
      compromissario: '-'
    },
    zoneamento: val(zon),
    mercado: {
      valorM2: vukt ? `${formatarReais(vukt)}/m² de terreno (PGV 2025)` : '-',
      imoveisVenda: '-',
      precoMedio: '-'
    },
    infraestrutura: val(transp),
    subprefeitura: a.gtm_nm_regional || '-',
    cartorio,
    matricula,
    pois: val(pois)
  };
}
