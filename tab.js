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

// Import IPTU data
const btnImport = document.getElementById('btn-import');
const fileIPTU = document.getElementById('file-iptu');
const importStatus = document.getElementById('import-status');
const importProgress = document.getElementById('import-progress');

btnImport.addEventListener('click', () => fileIPTU.click());
fileIPTU.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  importProgress.classList.remove('hidden');
  btnImport.disabled = true;
  try {
    const result = await importarIPTUJSON(file);
    importStatus.textContent = `Dados IPTU carregados: ${result.enderecos.toLocaleString()} endereços, ${result.unidades.toLocaleString()} unidades`;
    importStatus.className = 'import-status loaded';
    importProgress.classList.add('hidden');
  } catch (err) {
    importStatus.textContent = `Erro ao importar: ${err.message}`;
    importProgress.classList.add('hidden');
  }
  btnImport.disabled = false;
  fileIPTU.value = '';
});

(async () => {
  try {
    const loaded = await iptuIndexCarregado();
    if (loaded) {
      const db = await abrirIPTUDB();
      const tx = db.transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const enderecos = await new Promise(r => { const req = store.get('totalRegistros'); req.onsuccess = () => r(req.result); });
      const unidades = await new Promise(r => { const req = store.get('totalUnidades'); req.onsuccess = () => r(req.result); });
      db.close();
      importStatus.textContent = `Dados IPTU carregados: ${(enderecos || 0).toLocaleString()} endereços, ${(unidades || 0).toLocaleString()} unidades`;
      importStatus.className = 'import-status loaded';
    } else {
      importStatus.textContent = 'Dados IPTU não importados — busca de unidades em condomínios indisponível';
    }
  } catch (e) {
    importStatus.textContent = 'Dados IPTU não importados';
  }
})();

// Google Places API key
const apikeyInput = document.getElementById('apikey-input');
const apikeyStatus = document.getElementById('apikey-status');
const btnSaveApikey = document.getElementById('btn-save-apikey');

btnSaveApikey.addEventListener('click', async () => {
  const key = apikeyInput.value.trim();
  if (!key) return;
  await salvarApiKey(key);
  apikeyStatus.textContent = 'Google Places: configurado';
  apikeyStatus.className = 'import-status loaded';
  apikeyInput.value = '';
  apikeyInput.placeholder = 'Salvo';
});

(async () => {
  const key = await carregarApiKey();
  if (key) {
    apikeyStatus.textContent = 'Google Places: configurado';
    apikeyStatus.className = 'import-status loaded';
    apikeyInput.placeholder = 'Key salva (cole nova para substituir)';
  }
})();

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
    // Strip bloco/apartamento complement for geocoding and lookup
    const enderecoBase = stripComplemento(endereco);

    // 1. Geocodificar + buscar lote por nome em paralelo
    const [geoResult, geoSampaResult] = await Promise.allSettled([
      geocodificarEndereco(enderecoBase),
      buscarDadosGeoSampa(endereco, null)
    ]);

    let coordenadas = geoResult.status === 'fulfilled' ? geoResult.value : null;
    let geoSampaData = geoSampaResult.status === 'fulfilled' ? geoSampaResult.value : null;

    // If name query failed, retry with Nominatim coords (spatial fallback for condos)
    if ((!geoSampaData || geoSampaData.sql === '-') && coordenadas) {
      try {
        const fallback = await buscarDadosGeoSampa(endereco, coordenadas);
        if (fallback && fallback.sql !== '-') geoSampaData = fallback;
      } catch (e) {}
    }

    // Prefer GeoSampa lote centroid over Nominatim (more accurate for SP addresses)
    if (geoSampaData?.centroid) {
      coordenadas = {
        lat: geoSampaData.centroid.lat,
        lon: geoSampaData.centroid.lon,
        display_name: coordenadas?.display_name || endereco
      };
    }

    // 2. Buscar dados espaciais em paralelo (usando coordenadas precisas do lote)
    const { numero: numeroImovel } = extrairLogradouroNumero(enderecoBase);
    const dadosIPTUPromise = buscarDadosIPTU(geoSampaData, numeroImovel);
    const spatialPromises = [];
    if (coordenadas) {
      spatialPromises.push(
        buscarDadosZoneamento(coordenadas),          // index 0
        buscarDadosMercado(endereco, coordenadas),   // index 1
        buscarDadosInfraestrutura(coordenadas),      // index 2
        buscarSubprefeitura(coordenadas),            // index 3
        buscarCartorio(coordenadas),                 // index 4
        buscarPOIsGoogle(coordenadas)                // index 5
      );
    }
    const [spatialResults, dadosIPTU] = await Promise.all([
      Promise.allSettled(spatialPromises),
      dadosIPTUPromise
    ]);

    // 3. Fetch owner data using the SQL code (prefer unit SQL if found)
    const sqlParaProprietario = dadosIPTU?.unidadeEncontrada?.sql || geoSampaData?.sql;
    let proprietarioData = null;
    try {
      proprietarioData = await buscarProprietario(sqlParaProprietario);
    } catch (e) {
      proprietarioData = { proprietario: `Erro: ${e.message}`, compromissario: '-' };
    }

    // 4. Buscar matrícula (cache local → scraping → link manual)
    const cartorioData = coordenadas && spatialResults[4]?.status === 'fulfilled' ? spatialResults[4].value : { cartorio: '-', endereco: '-' };
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
      zoneamento: coordenadas && spatialResults[0]?.status === 'fulfilled' ? spatialResults[0].value : null,
      mercado: coordenadas && spatialResults[1]?.status === 'fulfilled' ? spatialResults[1].value : null,
      infraestrutura: coordenadas && spatialResults[2]?.status === 'fulfilled' ? spatialResults[2].value : null,
      subprefeitura: coordenadas && spatialResults[3]?.status === 'fulfilled' ? spatialResults[3].value : '-',
      cartorio: cartorioData,
      matricula: matriculaData,
      pois: coordenadas && spatialResults[5]?.status === 'fulfilled' ? spatialResults[5].value : null
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

function parseComplemento(endereco) {
  const blocoRe = /\b(?:bl\.?o?c?o?|blc\.?|bl\.?)\s*(\d+)/i;
  const aptoRe = /\b(?:a(?:p(?:t(?:o|\.)?|\.)?|partamento)\.?)\s*(\d+)/i;
  const blocoMatch = endereco.match(blocoRe);
  const aptoMatch = endereco.match(aptoRe);
  if (!blocoMatch && !aptoMatch) return null;
  return {
    bloco: blocoMatch ? blocoMatch[1] : null,
    apartamento: aptoMatch ? aptoMatch[1] : null,
    texto: [blocoMatch ? `Bloco ${blocoMatch[1]}` : '', aptoMatch ? `Apto ${aptoMatch[1]}` : ''].filter(Boolean).join(', ')
  };
}

function stripComplemento(endereco) {
  return endereco
    .replace(/,?\s*\b(?:bl\.?o?c?o?|blc\.?|bl\.?)\s*\d+/i, '')
    .replace(/,?\s*\b(?:a(?:p(?:t(?:o|\.)?|\.)?|partamento)\.?)\s*\d+/i, '')
    .replace(/,\s*,/g, ',')
    .replace(/,\s*$/, '')
    .trim();
}

function extrairLogradouroNumero(endereco) {
  const limpo = stripComplemento(endereco);
  const partes = limpo.split(',');
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
  const palavrasCompletas = todasPalavras.join(' ');
  const palavrasCurtas = todasPalavras.length > 2
    ? todasPalavras.slice(-2).join(' ')
    : palavrasCompletas;

  return { palavras: palavrasCompletas, palavrasCurtas, numero };
}

// Buscar dados cadastrais via GeoSampa WFS + CEP via ViaCEP
async function buscarDadosGeoSampa(endereco, coordenadas) {
  const complemento = parseComplemento(endereco);
  const enderecoBase = stripComplemento(endereco);

  const [geoSampaResult, viaCepResult] = await Promise.allSettled([
    buscarLoteGeoSampa(enderecoBase, coordenadas),
    buscarCepViaCEP(enderecoBase)
  ]);

  const lote = geoSampaResult.status === 'fulfilled' ? geoSampaResult.value : null;
  const cepData = viaCepResult.status === 'fulfilled' ? viaCepResult.value : null;
  const isCondominio = lote?.tipoUso === 'Condomínio' || lote?.cdLote === '0000';

  return {
    sql: lote?.sql || '-',
    setor: lote?.setor || null,
    quadra: lote?.quadra || null,
    distrito: cepData?.bairro || '-',
    cep: cepData?.cep || '-',
    bairro: cepData?.bairro || '-',
    logradouro: cepData?.logradouro || '-',
    areaTerreno: lote?.areaTerreno || null,
    areaConstruida: lote?.areaConstruida || null,
    tipoUso: lote?.tipoUso || null,
    centroid: lote?.centroid || null,
    isCondominio,
    complemento
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
  const setor = String(props.cd_setor_fiscal || '');
  const quadra = String(props.cd_quadra_fiscal || '');
  const lote = String(props.cd_lote || '');
  const digito = String(props.cd_digito_sql || '');

  const sql = (setor && quadra && lote)
    ? `${setor}.${quadra}.${lote}${digito && digito !== '0' ? '-' + digito : ''}`
    : '-';

  return {
    sql,
    setor,
    quadra,
    cdLote: lote,
    areaTerreno: props.qt_area_terreno != null ? `${parseFloat(props.qt_area_terreno).toFixed(2)} m²` : null,
    areaConstruida: props.qt_area_construida != null ? `${parseFloat(props.qt_area_construida).toFixed(2)} m²` : null,
    tipoUso: props.dc_tipo_uso_imovel || null
  };
}

function centroidFromGeometry(geometry) {
  if (!geometry || !geometry.coordinates) return null;
  let coords = [];
  if (geometry.type === 'Polygon') {
    coords = geometry.coordinates[0];
  } else if (geometry.type === 'MultiPolygon') {
    coords = geometry.coordinates[0][0];
  } else if (geometry.type === 'Point') {
    return { lat: geometry.coordinates[1], lon: geometry.coordinates[0] };
  }
  if (coords.length === 0) return null;
  let sumLon = 0, sumLat = 0;
  for (const c of coords) { sumLon += c[0]; sumLat += c[1]; }
  return { lat: sumLat / coords.length, lon: sumLon / coords.length };
}

async function buscarLoteGeoSampa(endereco, coordenadas) {
  const { palavras, palavrasCurtas, numero } = extrairLogradouroNumero(endereco);

  if (palavras && numero) {
    // 1. Try full street name (most specific)
    const cqlFull = `nm_logradouro_completo LIKE '%${palavras}%' AND cd_numero_porta='${numero}'`;
    try {
      const features = await consultarWfsGeoSampa(cqlFull);
      if (features.length > 0) {
        const dados = extrairDadosLote(features[0].properties);
        dados.centroid = centroidFromGeometry(features[0].geometry);
        return dados;
      }
    } catch (e) { /* WAF may block long queries - try shorter */ }

    // 2. If full name didn't match, try shorter (last 2 words) — only if different
    if (palavrasCurtas !== palavras) {
      const cqlShort = `nm_logradouro_completo LIKE '%${palavrasCurtas}%' AND cd_numero_porta='${numero}'`;
      const featuresShort = await consultarWfsGeoSampa(cqlShort);
      if (featuresShort.length === 1) {
        const dados = extrairDadosLote(featuresShort[0].properties);
        dados.centroid = centroidFromGeometry(featuresShort[0].geometry);
        return dados;
      }
      // Multiple results with short name — ambiguous, skip to spatial
    }

    // 3. Condo fallback (cd_numero_porta may be '0 2100 S/N')
    const cqlCondo = `nm_logradouro_completo LIKE '%${palavras}%' AND cd_numero_porta LIKE '%${numero}%' AND dc_tipo_uso_imovel='Condomínio'`;
    try {
      const condoFeatures = await consultarWfsGeoSampa(cqlCondo);
      if (condoFeatures.length > 0) {
        const dados = extrairDadosLote(condoFeatures[0].properties);
        dados.centroid = centroidFromGeometry(condoFeatures[0].geometry);
        return dados;
      }
    } catch (e) { /* WAF may block - fall through to spatial */ }
  }

  if (coordenadas) {
    const { lat, lon } = coordenadas;
    const utm = latLonToUTM23S(lat, lon);
    const cqlByCoord = `DWITHIN(ge_poligono,POINT(${utm.easting.toFixed(2)} ${utm.northing.toFixed(2)}),50,meters)`;
    const features = await consultarWfsGeoSampa(cqlByCoord);
    if (features.length > 0) {
      const dados = extrairDadosLote(features[0].properties);
      dados.centroid = centroidFromGeometry(features[0].geometry);
      return dados;
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

async function buscarDadosIPTU(dadosGeoSampa, numeroImovel) {
  const sqlDisponivel = dadosGeoSampa?.sql && dadosGeoSampa.sql !== '-';
  const isCondo = dadosGeoSampa?.isCondominio;
  const compl = dadosGeoSampa?.complemento;

  if (isCondo && compl && dadosGeoSampa?.setor && dadosGeoSampa?.quadra) {
    const unidade = await buscarUnidadeIPTU(dadosGeoSampa.setor, dadosGeoSampa.quadra, compl, numeroImovel);
    if (unidade && !unidade.semMatch) {
      return {
        valorVenal: 'Use o SQL da unidade acima no portal',
        areaTerreno: dadosGeoSampa?.areaTerreno || '-',
        areaConstruida: unidade.areaConstruida || '-',
        anoConstrucao: '-',
        tipoUso: 'Condomínio',
        unidadeEncontrada: unidade
      };
    }
    if (unidade?.semMatch) {
      return {
        valorVenal: `Condomínio com ${unidade.totalUnidades} unidades. Não encontrou "${compl.texto}" exato — consulte o portal IPTU.`,
        areaTerreno: dadosGeoSampa?.areaTerreno || '-',
        areaConstruida: '-',
        anoConstrucao: '-',
        tipoUso: `Condomínio — unidade: ${compl.texto}`,
        unidadeNaoEncontrada: true,
        totalUnidades: unidade.totalUnidades
      };
    }
  }

  let valorVenalMsg = sqlDisponivel
    ? 'Use o SQL acima no portal'
    : 'Requer SQL do imóvel';
  if (isCondo && compl) {
    valorVenalMsg = `Condomínio detectado (${compl.texto}). Importe os dados IPTU para consulta automática, ou acesse o portal IPTU.`;
  }
  return {
    valorVenal: valorVenalMsg,
    areaTerreno: dadosGeoSampa?.areaTerreno || '-',
    areaConstruida: dadosGeoSampa?.areaConstruida || '-',
    anoConstrucao: '-',
    tipoUso: isCondo && compl ? `Condomínio — unidade: ${compl.texto}` : (dadosGeoSampa?.tipoUso || '-')
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

// === GOOGLE PLACES API (POIs) ===

function salvarApiKey(key) {
  return new Promise(resolve => {
    chrome.storage.local.set({ googleApiKey: key }, resolve);
  });
}

function carregarApiKey() {
  return new Promise(resolve => {
    chrome.storage.local.get(['googleApiKey'], result => resolve(result.googleApiKey || null));
  });
}

async function buscarPOIsGoogle(coordenadas) {
  const apiKey = await carregarApiKey();
  if (!apiKey) return { erro: 'API key não configurada' };

  const tipos = [
    { type: 'supermarket', key: 'supermercado' },
    { type: 'pharmacy', key: 'farmacia' },
    { type: 'shopping_mall', key: 'shopping' }
  ];

  const results = await Promise.allSettled(
    tipos.map(t => buscarPOIGoogle(coordenadas, t.type, apiKey))
  );

  const data = {};
  tipos.forEach((t, i) => {
    const r = results[i].status === 'fulfilled' ? results[i].value : null;
    const err = results[i].status === 'rejected' ? results[i].reason?.message : null;
    if (r?.erro) {
      data[t.key + 'Proximo'] = `Erro: ${r.erro}`;
      data[t.key + 'Distancia'] = '-';
    } else if (r) {
      data[t.key + 'Proximo'] = r.nome;
      data[t.key + 'Distancia'] = `${r.distancia} metros`;
    } else {
      data[t.key + 'Proximo'] = err ? `Erro: ${err}` : 'Não encontrado';
      data[t.key + 'Distancia'] = '-';
    }
  });
  return data;
}

async function buscarPOIGoogle(coordenadas, type, apiKey) {
  // Try Places API (New) first
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'places.displayName,places.location'
      },
      body: JSON.stringify({
        includedTypes: [type],
        maxResultCount: 1,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: coordenadas.lat, longitude: coordenadas.lon },
            radius: 2000.0
          }
        },
        languageCode: 'pt-BR'
      })
    });

    if (resp.ok) {
      const data = await resp.json();
      if (data.places && data.places.length > 0) {
        const place = data.places[0];
        const dist = calcularDistancia(
          coordenadas.lat, coordenadas.lon,
          place.location.latitude, place.location.longitude
        );
        return {
          nome: place.displayName?.text || place.displayName || 'Sem nome',
          distancia: Math.round(dist)
        };
      }
      return null;
    }

    // If New API fails, try legacy endpoint
    const respBody = await resp.json().catch(() => ({}));
    console.warn('Places API (New) falhou:', resp.status, respBody);
  } catch (e) {
    console.warn('Places API (New) erro:', e.message);
  }

  // Fallback: legacy Nearby Search
  try {
    const url = `https://maps.googleapis.com/maps/api/place/nearbysearch/json`
      + `?location=${coordenadas.lat},${coordenadas.lon}`
      + `&radius=2000&type=${type}&key=${apiKey}&language=pt-BR`;
    const resp = await fetch(url);
    const data = await resp.json();

    if (data.status === 'OK' && data.results?.length > 0) {
      const place = data.results[0];
      const dist = calcularDistancia(
        coordenadas.lat, coordenadas.lon,
        place.geometry.location.lat, place.geometry.location.lng
      );
      return { nome: place.name, distancia: Math.round(dist) };
    }
    if (data.status === 'REQUEST_DENIED') {
      return { erro: data.error_message || 'API não habilitada' };
    }
  } catch (e) {
    console.warn('Legacy Places API erro:', e.message);
  }

  return null;
}

// === IPTU LOCAL INDEX (IndexedDB) ===

function abrirIPTUDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('iptu_condominios', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('indice')) {
        db.createObjectStore('indice');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function buscarUnidadeIPTU(setor, quadra, complemento, numeroImovel) {
  if (!setor || !quadra || !complemento) return null;
  const setorPad = String(setor).padStart(3, '0');
  const quadraPad = String(quadra).padStart(3, '0');
  const chave = `${setorPad}.${quadraPad}`;
  try {
    const db = await abrirIPTUDB();
    const tx = db.transaction('indice', 'readonly');
    const store = tx.objectStore('indice');
    const dados = await new Promise((resolve, reject) => {
      const req = store.get(chave);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();

    let unidades;
    if (Array.isArray(dados)) {
      unidades = dados;
    } else if (dados?.unidades && Array.isArray(dados.unidades)) {
      unidades = dados.unidades;
    } else {
      return null;
    }
    if (unidades.length === 0) return null;

    const match = matchComplemento(unidades, complemento, numeroImovel);
    if (match) {
      const compl = Array.isArray(match) ? match[0] : match.c;
      const lote = Array.isArray(match) ? match[1] : match.l;
      const digito = Array.isArray(match) ? match[2] : match.d;
      const area = Array.isArray(match) ? match[3] : match.a;
      return {
        sql: `${setorPad}.${quadraPad}.${lote}-${digito}`,
        complemento: compl,
        areaConstruida: area ? `${area} m²` : null,
        totalUnidades: unidades.length
      };
    }
    return { semMatch: true, totalUnidades: unidades.length, chave };
  } catch (e) {
    return null;
  }
}

function matchComplemento(unidades, parsed, numeroImovel) {
  const parsedBloco = parsed.bloco ? parseInt(parsed.bloco, 10) : null;
  const parsedApto = parsed.apartamento ? parseInt(parsed.apartamento, 10) : null;

  // Filter by building number first (index 4 in array format)
  let candidates = unidades;
  if (numeroImovel) {
    const filtered = unidades.filter(u => {
      const uNum = Array.isArray(u) && u.length > 4 ? String(u[4]) : null;
      return uNum === String(numeroImovel);
    });
    if (filtered.length > 0) candidates = filtered;
  }

  for (const u of candidates) {
    const c = (Array.isArray(u) ? u[0] : u.c || '').toUpperCase();
    const blocoCSV = c.match(/\bBL\.?\s*(\w+)/)?.[1];
    const aptoCSV = c.match(/\bAP(?:T(?:O)?)?\.?\s*(\w+)/)?.[1];

    const csvBloco = blocoCSV ? parseInt(blocoCSV, 10) : null;
    const csvApto = aptoCSV ? parseInt(aptoCSV, 10) : null;

    if (parsedBloco !== null && parsedApto !== null) {
      if (csvBloco === parsedBloco && csvApto === parsedApto) return u;
    } else if (parsedBloco !== null && parsedApto === null) {
      if (csvBloco === parsedBloco) return u;
    } else if (parsedBloco === null && parsedApto !== null) {
      if (csvApto === parsedApto) return u;
    }
  }
  return null;
}

async function iptuIndexCarregado() {
  try {
    const db = await abrirIPTUDB();
    const tx = db.transaction('meta', 'readonly');
    const store = tx.objectStore('meta');
    const count = await new Promise((resolve, reject) => {
      const req = store.get('totalRegistros');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count > 0;
  } catch (e) {
    return false;
  }
}

async function importarIPTUJSON(file) {
  const text = await file.text();
  const dados = JSON.parse(text);
  const chaves = Object.keys(dados);
  if (chaves.length === 0) throw new Error('Arquivo JSON vazio');

  const db = await abrirIPTUDB();
  const batchSize = 500;
  let total = 0;

  for (let i = 0; i < chaves.length; i += batchSize) {
    const batch = chaves.slice(i, i + batchSize);
    await new Promise((resolve, reject) => {
      const tx = db.transaction('indice', 'readwrite');
      const store = tx.objectStore('indice');
      for (const chave of batch) {
        store.put(dados[chave], chave);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    total += batch.length;
  }

  let totalUnidades = 0;
  for (const chave of chaves) {
    const v = dados[chave];
    if (Array.isArray(v)) {
      totalUnidades += v.length;
    } else if (v?.unidades && Array.isArray(v.unidades)) {
      totalUnidades += v.unidades.length;
    }
  }

  await new Promise((resolve, reject) => {
    const tx = db.transaction('meta', 'readwrite');
    const store = tx.objectStore('meta');
    store.put(chaves.length, 'totalRegistros');
    store.put(totalUnidades, 'totalUnidades');
    store.put(new Date().toISOString(), 'dataImportacao');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });

  db.close();
  return { enderecos: chaves.length, unidades: totalUnidades };
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
  const sqlEl = document.getElementById('sql');
  const sqlText = dados.geoSampa?.sql || '-';
  const unidade = dados.iptu?.unidadeEncontrada;

  if (unidade) {
    sqlEl.textContent = unidade.sql;
  } else if (dados.geoSampa?.isCondominio && dados.geoSampa?.complemento) {
    sqlEl.textContent = `${sqlText} (SQL do condomínio)`;
  } else {
    sqlEl.textContent = sqlText;
  }

  // Condo notice
  const condoNotice = document.getElementById('condo-notice');
  const condoLink = document.getElementById('condo-iptu-link');
  if (condoNotice) {
    if (unidade) {
      condoNotice.innerHTML = `Unidade encontrada: <strong>${unidade.complemento}</strong> (${unidade.totalUnidades} unidades no condomínio)`;
      condoNotice.style.display = 'block';
      condoNotice.className = 'condo-notice condo-found';
      if (condoLink) condoLink.style.display = 'none';
    } else if (dados.geoSampa?.isCondominio && dados.geoSampa?.complemento) {
      const compl = dados.geoSampa.complemento;
      const setor = dados.geoSampa.setor || '';
      const quadra = dados.geoSampa.quadra || '';
      if (dados.iptu?.unidadeNaoEncontrada) {
        condoNotice.textContent = `Condomínio encontrado (${dados.iptu?.totalUnidades || '?'} unidades), mas não foi possível localizar "${compl.texto}" exato. Verifique o formato do complemento.`;
      } else {
        let msg = `Este endereço é um condomínio. Você buscou: ${compl.texto}. `;
        msg += `Importe os dados IPTU (botão acima) para consulta automática, `;
        msg += `ou acesse o portal IPTU pelo setor ${setor} e quadra ${quadra}.`;
        condoNotice.textContent = msg;
      }
      condoNotice.style.display = 'block';
      condoNotice.className = 'condo-notice';
      if (condoLink) {
        condoLink.href = 'https://iptu.prefeitura.sp.gov.br/';
        condoLink.style.display = 'inline';
      }
    } else {
      condoNotice.style.display = 'none';
      if (condoLink) condoLink.style.display = 'none';
    }
  }
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

  document.getElementById('supermercado-proximo').textContent = dados.pois?.supermercadoProximo || '-';
  document.getElementById('supermercado-distancia').textContent = dados.pois?.supermercadoDistancia || '-';
  document.getElementById('farmacia-proxima').textContent = dados.pois?.farmaciaProximo || '-';
  document.getElementById('farmacia-distancia').textContent = dados.pois?.farmaciaDistancia || '-';
  document.getElementById('shopping-proximo').textContent = dados.pois?.shoppingProximo || '-';
  document.getElementById('shopping-distancia').textContent = dados.pois?.shoppingDistancia || '-';

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
