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

    // 4. Exibir resultados
    exibirResultados({
      coordenadas: coordenadas || { lat: 0, lon: 0, display_name: endereco },
      geoSampa: geoSampaData,
      iptu: dadosIPTU,
      proprietario: proprietarioData,
      zoneamento: coordenadas && results[1]?.status === 'fulfilled' ? results[1].value : null,
      mercado: coordenadas && results[2]?.status === 'fulfilled' ? results[2].value : null,
      infraestrutura: coordenadas && results[3]?.status === 'fulfilled' ? results[3].value : null,
      subprefeitura: coordenadas && results[4]?.status === 'fulfilled' ? results[4].value : '-',
      cartorio: coordenadas && results[5]?.status === 'fulfilled' ? results[5].value : { cartorio: '-', endereco: '-' }
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
async function consultarWfsGeoSampaLayer(typeName, cqlFilter, propertyName) {
  let wfsUrl = `http://wfs.geosampa.prefeitura.sp.gov.br/geoserver/geoportal/ows`
    + `?service=WFS&version=2.0.0&request=GetFeature`
    + `&typeName=${typeName}&count=1`
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

// Buscar estação de metrô mais próxima via Overpass API
async function buscarDadosInfraestrutura(coordenadas) {
  try {
    const query = `[out:json][timeout:10];node["railway"="station"]["station"="subway"](around:2000,${coordenadas.lat},${coordenadas.lon});out body;`;
    const resp = await chrome.runtime.sendMessage({
      action: 'fetchPost',
      url: 'https://overpass-api.de/api/interpreter',
      body: `data=${encodeURIComponent(query)}`
    });
    if (!resp.success) throw new Error(resp.error);
    const data = resp.data;

    if (data.elements && data.elements.length > 0) {
      let closest = null;
      let minDist = Infinity;
      for (const el of data.elements) {
        const d = calcularDistancia(coordenadas.lat, coordenadas.lon, el.lat, el.lon);
        if (d < minDist) { minDist = d; closest = el; }
      }
      return {
        metroProximo: closest.tags?.name || 'Estação sem nome',
        metroDistancia: `${minDist.toFixed(0)} metros`
      };
    }

    return {
      metroProximo: 'Nenhuma estação próxima (raio de 2km)',
      metroDistancia: '-'
    };
  } catch (erro) {
    return {
      metroProximo: `Erro: ${erro.message}`,
      metroDistancia: '-'
    };
  }
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
