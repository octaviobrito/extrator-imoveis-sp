// Elementos DOM
const enderecoInput = document.getElementById('endereco');
const buscarBtn = document.getElementById('buscar');
const loadingDiv = document.getElementById('loading');
const erroDiv = document.getElementById('erro');
const resultadosDiv = document.getElementById('resultados');

// Event Listeners
buscarBtn.addEventListener('click', buscarDados);
enderecoInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') buscarDados();
});

// Auto-search if address passed via URL parameter
const params = new URLSearchParams(window.location.search);
const enderecoParam = params.get('endereco');
if (enderecoParam) {
  enderecoInput.value = enderecoParam;
  buscarDados();
}

// Função principal de busca
async function buscarDados() {
  const endereco = enderecoInput.value.trim();

  if (!endereco) {
    mostrarErro('Por favor, digite um endereço válido.');
    return;
  }

  mostrarLoading();
  limparResultados();

  try {
    // 1. Geocodificar endereço (non-fatal)
    let coordenadas = null;
    try {
      coordenadas = await geocodificarEndereco(endereco);
    } catch (e) {
      // Geocoding failed — GeoSampa name+number query still works
    }

    // 2. Buscar dados em paralelo
    const promises = [
      buscarDadosGeoSampa(endereco, coordenadas),  // index 0
    ];
    if (coordenadas) {
      promises.push(
        buscarDadosZoneamento(coordenadas),          // index 1
        buscarDadosMercado(endereco, coordenadas),   // index 2
        buscarDadosInfraestrutura(coordenadas),      // index 3
        buscarSubprefeitura(coordenadas),            // index 4
        buscarCartorio(coordenadas)                  // index 5
      );
    }
    const results = await Promise.allSettled(promises);

    const geoSampaData = results[0].status === 'fulfilled' ? results[0].value : null;
    const dadosIPTU = buscarDadosIPTU(geoSampaData);

    // 3. Fetch owner data using the SQL code
    let proprietarioData = null;
    try {
      proprietarioData = await buscarProprietario(geoSampaData?.sql);
    } catch (e) {
      proprietarioData = { proprietario: `Erro: ${e.message}`, compromissario: '-' };
    }

    // 4. Buscar matrícula (cache local → scraping → link manual)
    const cartorioData = coordenadas && results[5]?.status === 'fulfilled' ? results[5].value : { cartorio: '-', endereco: '-' };
    let matriculaData = null;
    try {
      matriculaData = await buscarMatricula(geoSampaData?.sql, endereco, cartorioData);
    } catch (e) {
      matriculaData = { matricula: '-', fonte: '' };
    }

    // 5. Exibir resultados
    exibirResultados({
      coordenadas: coordenadas || { lat: 0, lon: 0, display_name: endereco },
      geoSampa: geoSampaData,
      iptu: dadosIPTU,
      proprietario: proprietarioData,
      zoneamento: coordenadas && results[1]?.status === 'fulfilled' ? results[1].value : null,
      mercado: coordenadas && results[2]?.status === 'fulfilled' ? results[2].value : null,
      infraestrutura: coordenadas && results[3]?.status === 'fulfilled' ? results[3].value : null,
      subprefeitura: coordenadas && results[4]?.status === 'fulfilled' ? results[4].value : '-',
      cartorio: cartorioData,
      matricula: matriculaData
    });

    esconderLoading();

  } catch (erro) {
    esconderLoading();
    mostrarErro(`Erro ao buscar dados: ${erro.message}`);
  }
}

// Geocodificação via Nominatim (OpenStreetMap)
async function geocodificarEndereco(endereco) {
  const enderecoCompleto = `${endereco}, São Paulo, SP, Brasil`;
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(enderecoCompleto)}&limit=1`;

  const response = await fetch(url, {
    headers: { 'User-Agent': 'ExtensaoImoveisSP/1.0' }
  });
  const data = await response.json();

  if (data.length === 0) {
    throw new Error('Endereço não encontrado');
  }

  return {
    lat: parseFloat(data[0].lat),
    lon: parseFloat(data[0].lon),
    display_name: data[0].display_name
  };
}

function removerAcentos(str) {
  return str.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function extrairLogradouroNumero(endereco) {
  const partes = endereco.split(',');
  const ruaPart = partes[0].trim();
  const numPart = partes.length > 1 ? partes[1].trim() : '';

  let numero = numPart.replace(/\D/g, '');
  let nomeRua = ruaPart;
  if (!numero) {
    const match = ruaPart.match(/^(.+?)\s+(\d+)\s*$/);
    if (match) {
      nomeRua = match[1];
      numero = match[2];
    }
  }

  const semAcento = removerAcentos(nomeRua).toUpperCase();
  const semPrefixo = semAcento
    .replace(/^(RUA|R\.|AVENIDA|AV\.|ALAMEDA|AL\.|TRAVESSA|TV\.|PRACA|PCA\.|LARGO|VIELA|ESTRADA|ESTR\.)\s+/i, '')
    .trim();

  const todasPalavras = semPrefixo.split(/\s+/).filter(w => w.length > 0);
  const palavras = todasPalavras.length > 2
    ? todasPalavras.slice(-2).join(' ')
    : todasPalavras.join(' ');

  return { palavras, numero };
}

// Buscar dados cadastrais via GeoSampa WFS + CEP via ViaCEP
async function buscarDadosGeoSampa(endereco, coordenadas) {
  const [geoSampaResult, viaCepResult] = await Promise.allSettled([
    buscarLoteGeoSampa(endereco, coordenadas),
    buscarCepViaCEP(endereco)
  ]);

  const lote = geoSampaResult.status === 'fulfilled' ? geoSampaResult.value : null;
  const cepData = viaCepResult.status === 'fulfilled' ? viaCepResult.value : null;

  return {
    sql: lote?.sql || '-',
    distrito: cepData?.bairro || '-',
    cep: cepData?.cep || '-',
    bairro: cepData?.bairro || '-',
    logradouro: cepData?.logradouro || '-',
    areaTerreno: lote?.areaTerreno || null,
    areaConstruida: lote?.areaConstruida || null,
    tipoUso: lote?.tipoUso || null
  };
}

// Convert WGS84 to UTM EPSG:31983 (SIRGAS 2000 / UTM zone 23S)
function latLonToUTM23S(lat, lon) {
  const a = 6378137.0;
  const f = 1 / 298.257223563;
  const e2 = 2 * f - f * f;
  const ep2 = e2 / (1 - e2);
  const k0 = 0.9996;
  const lon0 = -45.0;

  const latRad = lat * Math.PI / 180;
  const lonRad = lon * Math.PI / 180;
  const lon0Rad = lon0 * Math.PI / 180;

  const N = a / Math.sqrt(1 - e2 * Math.sin(latRad) ** 2);
  const T = Math.tan(latRad) ** 2;
  const C = ep2 * Math.cos(latRad) ** 2;
  const A = (lonRad - lon0Rad) * Math.cos(latRad);

  const M = a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latRad
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latRad)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latRad)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * latRad)
  );

  const easting = k0 * N * (A + (1 - T + C) * A ** 3 / 6
    + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000;

  let northing = k0 * (M + N * Math.tan(latRad) * (A ** 2 / 2
    + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
    + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720));
  if (lat < 0) northing += 10000000;

  return { easting, northing };
}

// WFS request to GeoSampa lote_cidadao layer
async function consultarWfsGeoSampa(cqlFilter) {
  const wfsUrl = `http://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/ows`
    + `?service=WFS&version=2.0.0&request=GetFeature`
    + `&typeName=geoportal:lote_cidadao&count=5`
    + `&outputFormat=application/json&srsName=EPSG:4326`
    + `&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;

  const response = await fetch(wfsUrl);
  const data = await response.json();
  return data.features || [];
}

// Generic WFS query to any GeoSampa layer
async function consultarWfsGeoSampaLayer(typeName, cqlFilter, propertyName, count = 1) {
  let wfsUrl = `http://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/ows`
    + `?service=WFS&version=2.0.0&request=GetFeature`
    + `&typeName=${typeName}&count=${count}`
    + `&outputFormat=application/json&srsName=EPSG:31983`
    + `&CQL_FILTER=${encodeURIComponent(cqlFilter)}`;
  if (propertyName) {
    wfsUrl += `&propertyName=${propertyName}`;
  }
  const response = await fetch(wfsUrl);
  const data = await response.json();
  return data.features || [];
}

// Buscar subprefeitura via GeoSampa WFS
async function buscarSubprefeitura(coordenadas) {
  const utm = latLonToUTM23S(coordenadas.lat, coordenadas.lon);
  const cql = `INTERSECTS(ge_poligono,POINT(${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)}))`;
  const features = await consultarWfsGeoSampaLayer(
    'geoportal:subprefeitura', cql, 'nm_subprefeitura,sg_subprefeitura'
  );
  if (features.length > 0) {
    const props = features[0].properties;
    return props.nm_subprefeitura || props.sg_subprefeitura || '-';
  }
  return '-';
}

// Buscar cartório de registro de imóveis via GeoSampa WFS
async function buscarCartorio(coordenadas) {
  const utm = latLonToUTM23S(coordenadas.lat, coordenadas.lon);
  const cql = `INTERSECTS(ge_poligono,POINT(${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)}))`;
  const features = await consultarWfsGeoSampaLayer(
    'geoportal:cartorio_registro_imovel', cql, 'cd_numero_cartorio,nm_endereco_cartorio'
  );
  if (features.length > 0) {
    const props = features[0].properties;
    const num = props.cd_numero_cartorio;
    if (num) {
      return {
        cartorio: `${num} Registro de Imóveis de São Paulo`,
        endereco: props.nm_endereco_cartorio || '-'
      };
    }
  }
  return { cartorio: '-', endereco: '-' };
}

function extrairDadosLote(props) {
  const setor = props.cd_setor_fiscal || '';
  const quadra = props.cd_quadra_fiscal || '';
  const lote = props.cd_lote || '';
  const digito = props.cd_digito_sql || '';

  const sql = (setor && quadra && lote)
    ? `${setor}.${quadra}.${lote}${digito && digito !== '0' ? '-' + digito : ''}`
    : '-';

  return {
    sql,
    areaTerreno: props.qt_area_terreno != null ? `${parseFloat(props.qt_area_terreno).toFixed(2)} m²` : null,
    areaConstruida: props.qt_area_construida != null ? `${parseFloat(props.qt_area_construida).toFixed(2)} m²` : null,
    tipoUso: props.dc_tipo_uso_imovel || null
  };
}

async function buscarLoteGeoSampa(endereco, coordenadas) {
  const { palavras, numero } = extrairLogradouroNumero(endereco);
  if (palavras && numero) {
    const cqlByName = `nm_logradouro_completo LIKE '%${palavras}%' AND cd_numero_porta='${numero}'`;
    const features = await consultarWfsGeoSampa(cqlByName);
    if (features.length > 0) {
      return extrairDadosLote(features[0].properties);
    }
  }

  if (coordenadas) {
    const { lat, lon } = coordenadas;
    const utm = latLonToUTM23S(lat, lon);
    const cqlByCoord = `DWITHIN(ge_poligono,POINT(${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)}),50,meters)`;
    const features = await consultarWfsGeoSampa(cqlByCoord);
    if (features.length > 0) {
      return extrairDadosLote(features[0].properties);
    }
  }

  return null;
}

async function buscarCepViaCEP(endereco) {
  const logradouro = endereco
    .replace(/,.*$/, '')
    .replace(/\d+/g, '')
    .trim();

  if (!logradouro) {
    return { cep: '-', bairro: '-', logradouro: '-' };
  }

  const url = `https://viacep.com.br/ws/SP/São Paulo/${encodeURIComponent(logradouro)}/json/`;
  const response = await fetch(url);
  const data = await response.json();

  if (Array.isArray(data) && data.length > 0) {
    return {
      cep: data[0].cep || '-',
      bairro: data[0].bairro || '-',
      logradouro: data[0].logradouro || '-'
    };
  }

  return { cep: 'Não encontrado', bairro: '-', logradouro: '-' };
}

function buscarDadosIPTU(dadosGeoSampa) {
  const sqlDisponivel = dadosGeoSampa?.sql && dadosGeoSampa.sql !== '-';
  return {
    valorVenal: sqlDisponivel
      ? 'Use o SQL acima no portal'
      : 'Requer SQL do imóvel',
    areaTerreno: dadosGeoSampa?.areaTerreno || '-',
    areaConstruida: dadosGeoSampa?.areaConstruida || '-',
    anoConstrucao: '-',
    tipoUso: dadosGeoSampa?.tipoUso || '-'
  };
}

// Buscar proprietário via portal da Prefeitura (sf8663)
async function buscarProprietario(sql) {
  if (!sql || sql === '-') {
    return { proprietario: '-', compromissario: '-' };
  }

  const match = sql.match(/^(\d+)\.(\d+)\.(\d+)(?:-(\d+))?$/);
  if (!match) {
    return { proprietario: '-', compromissario: '-' };
  }
  const [, setor, quadra, lote, digito] = match;

  const baseUrl = 'https://www3.prefeitura.sp.gov.br/sf8663/formsinternet/principal.aspx';

  const getResp = await fetch(baseUrl, { credentials: 'include' });
  if (!getResp.ok) {
    return { proprietario: `Portal indisponível (HTTP ${getResp.status})`, compromissario: '-' };
  }
  const getHtml = await getResp.text();

  const viewState = (getHtml.match(/name="__VIEWSTATE"[^>]*value="([^"]*)"/) || [])[1] || '';
  const eventValidation = (getHtml.match(/name="__EVENTVALIDATION"[^>]*value="([^"]*)"/) || [])[1] || '';
  const viewStateGen = (getHtml.match(/name="__VIEWSTATEGENERATOR"[^>]*value="([^"]*)"/) || [])[1] || '';

  const formData = new URLSearchParams({
    '__VIEWSTATE': viewState,
    '__VIEWSTATEGENERATOR': viewStateGen,
    '__EVENTVALIDATION': eventValidation,
    'PageProdamSPOnChange': '',
    'PageProdamSPPosicao': '',
    'PageProdamSPFocado': '',
    'txtSetor': setor,
    'txtQuadra': quadra,
    'txtLote': lote,
    'txtDigito': digito || '0',
    'hpSql': '',
    '_BtnAvancarDasii': 'Avançar'
  });

  const postResp = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formData.toString(),
    credentials: 'include'
  });

  if (!postResp.ok) {
    return { proprietario: `Portal indisponível (HTTP ${postResp.status})`, compromissario: '-' };
  }
  const postHtml = await postResp.text();

  const propMatch = postHtml.match(/name="txtProprietarioNome"[^>]*value="([^"]*)"/);
  const compMatch = postHtml.match(/name="txtCompromissarioNome"[^>]*value="([^"]*)"/);

  return {
    proprietario: propMatch?.[1] || '-',
    compromissario: compMatch?.[1] || '-'
  };
}

// Buscar zoneamento via GeoSampa WFS (Lei 18.177/2024, fallback Lei 13.885/2004)
async function buscarDadosZoneamento(coordenadas) {
  const utm = latLonToUTM23S(coordenadas.lat, coordenadas.lon);
  const point = `POINT(${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)})`;

  // Try new law first (INTERSECTS then DWITHIN for boundary cases)
  let features = await consultarWfsGeoSampaLayer(
    'geoportal:perimetro_zona_lei_18177_24',
    `INTERSECTS(ge_poligono,${point})`,
    'cd_zoneamento_perimetro,tx_zoneamento_perimetro,cd_numero_legislacao_zoneamento,an_legislacao_zoneamento'
  );
  if (features.length === 0) {
    features = await consultarWfsGeoSampaLayer(
      'geoportal:perimetro_zona_lei_18177_24',
      `DWITHIN(ge_poligono,${point},100,meters)`,
      'cd_zoneamento_perimetro,tx_zoneamento_perimetro,cd_numero_legislacao_zoneamento,an_legislacao_zoneamento'
    );
  }

  // Fallback to old law
  if (features.length === 0) {
    features = await consultarWfsGeoSampaLayer(
      'geoportal:perimetro_zoneamento_revogado_lei13885',
      `INTERSECTS(ge_poligono,${point})`,
      'cd_zoneamento_perimetro,tx_zoneamento_perimetro,cd_numero_legislacao_zoneamento,an_legislacao_zoneamento'
    );
  }

  if (features.length > 0) {
    const props = features[0].properties;
    const sigla = props.cd_zoneamento_perimetro || '-';
    const descricao = props.tx_zoneamento_perimetro || '';
    const lei = props.cd_numero_legislacao_zoneamento;
    const ano = props.an_legislacao_zoneamento;
    const zonaTexto = descricao ? `${sigla} - ${descricao}` : sigla;
    return {
      zona: lei ? `${zonaTexto} (Lei ${lei}/${ano})` : zonaTexto,
      coefAprov: 'Consultar tabela da lei de zoneamento',
      gabarito: 'Consultar tabela da lei de zoneamento'
    };
  }

  return {
    zona: 'Não encontrado',
    coefAprov: '-',
    gabarito: '-'
  };
}

async function buscarDadosMercado(endereco, coordenadas) {
  return {
    valorM2: 'R$ 8.000 - R$ 12.000 (estimativa região central)',
    imoveisVenda: 'Dados via ZAP/Viva Real',
    precoMedio: 'Varia por bairro'
  };
}

// Find closest station from a GeoSampa feature array (coordinates in UTM)
function encontrarEstacaoMaisProxima(features, utmEasting, utmNorthing) {
  let closest = null;
  let minDist = Infinity;
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords) continue;
    const dx = coords[0] - utmEasting;
    const dy = coords[1] - utmNorthing;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d < minDist) { minDist = d; closest = f; }
  }
  if (!closest) return null;
  return {
    nome: closest.properties.nm_estacao_metro_trem,
    linha: closest.properties.nm_linha_metro_trem,
    distancia: minDist
  };
}

// Buscar metrô e trem mais próximos via GeoSampa WFS
async function buscarDadosInfraestrutura(coordenadas) {
  const utm = latLonToUTM23S(coordenadas.lat, coordenadas.lon);
  const point = `POINT(${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)})`;
  const props = 'nm_estacao_metro_trem,nm_linha_metro_trem,ge_ponto';
  const result = {
    metroProximo: '-', metroDistancia: '-',
    tremProximo: '-', tremDistancia: '-'
  };

  try {
    const [metroFeatures, tremFeatures] = await Promise.all([
      consultarWfsGeoSampaLayer('geoportal:estacao_metro', `DWITHIN(ge_ponto,${point},5000,meters)`, props, 10),
      consultarWfsGeoSampaLayer('geoportal:estacao_trem', `DWITHIN(ge_ponto,${point},5000,meters)`, props, 10)
    ]);

    const metro = encontrarEstacaoMaisProxima(metroFeatures, utm.easting, utm.northing);
    if (metro) {
      result.metroProximo = `${metro.nome} (Linha ${metro.linha})`;
      result.metroDistancia = `${metro.distancia.toFixed(0)} metros`;
    } else {
      result.metroProximo = 'Nenhuma estação próxima (5km)';
    }

    const trem = encontrarEstacaoMaisProxima(tremFeatures, utm.easting, utm.northing);
    if (trem) {
      result.tremProximo = `${trem.nome} (Linha ${trem.linha})`;
      result.tremDistancia = `${trem.distancia.toFixed(0)} metros`;
    } else {
      result.tremProximo = 'Nenhuma estação próxima (5km)';
    }
  } catch (erro) {
    result.metroProximo = `Erro: ${erro.message}`;
    result.tremProximo = `Erro: ${erro.message}`;
  }

  return result;
}

function calcularDistancia(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// === MATRÍCULA: cache local + scraping ===

// URLs dos cartórios de SP para consulta manual
const CARTORIOS_URL = {
  '1º': 'https://www.primeirosp.com.br',
  '2º': 'https://www.2risp.com.br/?pG=X19jb25zdWx0YV9pbmRpY2Fkb3JfcmVhbF9jYXJ0b29u',
  '3º': 'https://3risp.com.br',
  '4º': 'https://www.4risp.com.br/cartorio/consultas/ri/indicador/ri-consulta-indicador',
  '5º': 'https://www.quinto.com.br/consulte/pesquisa-de-matricula',
  '6º': 'https://www.6risp.com.br',
  '7º': 'https://www.7risp.com.br',
  '8º': 'https://www.oitavo.com.br/consultaeletronica/imovel',
  '9º': 'https://www.9risp.com.br/?pG=X19yZWFs',
  '10º': 'https://www.10risp.com.br',
  '11º': 'https://web.11ri.com.br',
  '12º': 'https://www.12ri.com.br',
  '13º': 'https://www.13registro.com.br',
  '14º': 'https://www.14ri.com.br',
  '15º': 'https://www.decimoquinto.com.br',
  '16º': 'https://www.16ri.com.br',
  '17º': 'https://17risp.com.br',
  '18º': 'https://www.18risp.com.br'
};

async function buscarMatricula(sql, endereco, cartorioData) {
  if (!sql || sql === '-') return { matricula: '-', fonte: '' };

  // 1. Check cache
  const cacheKey = `matricula_${sql}`;
  const cached = await getCachedMatricula(cacheKey);
  if (cached) return { matricula: cached.matricula, fonte: 'cache local' };

  // 2. Try automated scraping (8º RI only)
  const numCartorio = cartorioData?.cartorio?.match(/^(\d+)º/)?.[1];
  if (numCartorio === '8') {
    try {
      const matricula = await scrapeOitavoRI(endereco);
      if (matricula) {
        await salvarMatriculaCache(cacheKey, matricula, numCartorio);
        return { matricula, fonte: 'scraping 8º RI' };
      }
    } catch (e) {
      // Scraping failed, fall through
    }
  }

  // 3. Return link for manual lookup
  const cartNum = numCartorio ? `${numCartorio}º` : null;
  const url = cartNum && CARTORIOS_URL[cartNum] ? CARTORIOS_URL[cartNum] : null;
  return { matricula: '-', fonte: '', urlCartorio: url, numCartorio: cartNum };
}

async function scrapeOitavoRI(endereco) {
  const { palavras, numero } = extrairLogradouroNumero(endereco);
  if (!palavras || !numero) return null;

  const body = `tipopesquisa=endereco&endereco=${encodeURIComponent(palavras)}&numero=${encodeURIComponent(numero)}&busca=Procurar`;
  const resp = await chrome.runtime.sendMessage({
    action: 'fetchHtml',
    url: 'https://www.oitavo.com.br/consultaeletronica/result_pesquisa_imovel.php',
    method: 'POST',
    body,
    headers: { 'Referer': 'https://www.oitavo.com.br/consultaeletronica/imovel' }
  });

  if (!resp.success) return null;

  const match = resp.html.match(/matr[ií]cula[^0-9]*(\d+)/i);
  return match ? match[1] : null;
}

async function getCachedMatricula(key) {
  return new Promise(resolve => {
    chrome.storage.local.get([key], result => resolve(result[key] || null));
  });
}

async function salvarMatriculaCache(key, matricula, cartorio) {
  const data = { matricula, cartorio, data: new Date().toISOString() };
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: data }, resolve);
  });
}

// Exibir resultados na interface
function exibirResultados(dados) {
  document.getElementById('endereco-completo').textContent = dados.coordenadas.display_name;
  document.getElementById('cep').textContent = dados.geoSampa?.cep || '-';
  document.getElementById('bairro').textContent = dados.geoSampa?.bairro || '-';
  document.getElementById('distrito').textContent = dados.geoSampa?.distrito || '-';
  document.getElementById('subprefeitura').textContent = dados.subprefeitura || '-';
  document.getElementById('sql').textContent = dados.geoSampa?.sql || '-';
  document.getElementById('proprietario').textContent = dados.proprietario?.proprietario || '-';
  document.getElementById('compromissario').textContent = dados.proprietario?.compromissario || '-';
  document.getElementById('cartorio').textContent = dados.cartorio?.cartorio || '-';

  // Matrícula
  const matriculaSpan = document.getElementById('matricula');
  const matriculaLink = document.getElementById('matricula-link');
  const btnSalvar = document.getElementById('btn-salvar-matricula');
  const inputRow = document.getElementById('matricula-input-row');
  const mat = dados.matricula;

  if (mat?.matricula && mat.matricula !== '-') {
    matriculaSpan.textContent = mat.matricula + (mat.fonte ? ` (${mat.fonte})` : '');
    matriculaLink.style.display = 'none';
    btnSalvar.style.display = 'none';
    inputRow.style.display = 'none';
  } else {
    matriculaSpan.textContent = 'Não encontrada';
    if (mat?.urlCartorio) {
      matriculaLink.href = mat.urlCartorio;
      matriculaLink.style.display = 'inline';
    }
    btnSalvar.style.display = 'inline';
    btnSalvar.onclick = () => {
      inputRow.style.display = 'block';
      btnSalvar.style.display = 'none';
    };
    document.getElementById('btn-confirmar-matricula').onclick = async () => {
      const val = document.getElementById('matricula-manual').value.trim();
      if (!val) return;
      const sql = dados.geoSampa?.sql;
      if (sql && sql !== '-') {
        await salvarMatriculaCache(`matricula_${sql}`, val, mat?.numCartorio || '');
        matriculaSpan.textContent = `${val} (salvo manualmente)`;
        inputRow.style.display = 'none';
        matriculaLink.style.display = 'none';
      }
    };
  }

  document.getElementById('valor-venal').textContent = dados.iptu?.valorVenal || '-';
  document.getElementById('area-terreno').textContent = dados.iptu?.areaTerreno || '-';
  document.getElementById('area-construida').textContent = dados.iptu?.areaConstruida || '-';
  document.getElementById('ano-construcao').textContent = dados.iptu?.anoConstrucao || '-';
  document.getElementById('tipo-uso').textContent = dados.iptu?.tipoUso || '-';

  const valorVenalLink = document.getElementById('valor-venal-link');
  if (valorVenalLink) {
    const sql = dados.geoSampa?.sql;
    if (sql && sql !== '-') {
      valorVenalLink.href = 'https://iptu.prefeitura.sp.gov.br/';
      valorVenalLink.style.display = 'inline';
    } else {
      valorVenalLink.style.display = 'none';
    }
  }

  document.getElementById('zona').textContent = dados.zoneamento?.zona || '-';
  document.getElementById('coef-aprov').textContent = dados.zoneamento?.coefAprov || '-';
  document.getElementById('gabarito').textContent = dados.zoneamento?.gabarito || '-';

  document.getElementById('valor-m2').textContent = dados.mercado?.valorM2 || '-';
  document.getElementById('imoveis-venda').textContent = dados.mercado?.imoveisVenda || '-';
  document.getElementById('preco-medio').textContent = dados.mercado?.precoMedio || '-';

  document.getElementById('metro-proximo').textContent = dados.infraestrutura?.metroProximo || '-';
  document.getElementById('metro-distancia').textContent = dados.infraestrutura?.metroDistancia || '-';
  document.getElementById('trem-proximo').textContent = dados.infraestrutura?.tremProximo || '-';
  document.getElementById('trem-distancia').textContent = dados.infraestrutura?.tremDistancia || '-';

  resultadosDiv.classList.remove('hidden');
}

function mostrarLoading() {
  loadingDiv.classList.remove('hidden');
  erroDiv.classList.add('hidden');
  resultadosDiv.classList.add('hidden');
}

function esconderLoading() {
  loadingDiv.classList.add('hidden');
}

function mostrarErro(mensagem) {
  erroDiv.textContent = mensagem;
  erroDiv.classList.remove('hidden');
}

function limparResultados() {
  resultadosDiv.classList.add('hidden');
}
