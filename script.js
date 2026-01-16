// --- CONFIGURAÇÕES ---
const CONFIG = {
  baseUrl: "https://homolog.irridesk.com.br"
  // baseUrl: "http://localhost:8000"
};

// --- CONFIGURAÇÃO VISUAL DAS BANDAS ---
const BAND_STYLE = {
  "NDVI": { class: "color-green", icon: "bi-tree" },
  "EVI":  { class: "color-yellow", icon: "bi-exclamation-triangle" },
  "NDWI": { class: "color-red", icon: "bi-water" },
  "GNDVI": { class: "color-blue", icon: "bi-flower2" },
  "NDMI": { class: "color-green", icon: "bi-droplet" },
  "NDRE": { class: "color-red", icon: "bi-heart-pulse" },
  "SWIR1": { class: "color-yellow", icon: "bi-thermometer-sun" },
  "SWIR2": { class: "color-green", icon: "bi-sun" },
  "MSAVI2": { class: "color-blue", icon: "bi-bullseye" },
  "NIR": { class: "color-yellow", icon: "bi-wifi" }
};
const BAND_ORDER = ["NDVI", "EVI", "NDWI", "GNDVI", "NDMI", "NDRE", "SWIR1", "SWIR2", "MSAVI2", "NIR"];

// Estado Global
let state = {
  accessToken: null,
  currentIdAna: null, // Será definido pelo gpkg_reference do equipamento selecionado
  
  farms: [],
  equipments: [],
  
  availability: [],       
  allBands: [],           
  bandsByDate: new Map(), 
  
  selectedDate: null,
  selectedBand: null,
  lastObjectUrl: null,

  chartInstance: null
};

// Elementos DOM
const els = {
  // Login
  loginOverlay: document.getElementById("loginOverlay"),
  loginForm: document.getElementById("loginForm"),
  emailInput: document.getElementById("email"),
  passInput: document.getElementById("password"),
  submitLogin: document.getElementById("submitLogin"),
  loginError: document.getElementById("loginError"),
  btnLogout: document.getElementById("btnLogout"),

  // Buscas (Novos Elementos)
  farmSelect: document.getElementById("farmSelect"),
  equipmentSelect: document.getElementById("equipmentSelect"),
  btnSearch: document.getElementById("btnSearch"),

  // Dados
  dateSelect: document.getElementById("dateSelect"),
  bandsContainer: document.getElementById("bandsContainer"),
  pivotImage: document.getElementById("pivotImage"),
  imgLoader: document.getElementById("imgLoader"),
  currentInfo: document.getElementById("currentInfo"),

  // RDI
  analysisSection: document.getElementById("analysisSection"),
  rdiValue: document.getElementById("rdiValue"),
  rdiStatus: document.getElementById("rdiStatus"),
  metricCard: document.querySelector(".metric-card"),

  // CHART
  chartContainer: document.getElementById("chartContainer"),
};

// -------------------------
// FETCH HELPERS
// -------------------------
async function fetchJson(url) {
  if (!state.accessToken) {
    window.location.reload();
    throw new Error("Sessão expirada");
  }

  const resp = await fetch(url, { headers: { Authorization: `Bearer ${state.accessToken}` } });
  
  if (resp.status === 401) {
    alert("Sessão expirada. Faça login novamente.");
    window.location.reload();
    return;
  }

  const json = await resp.json();
  if (!resp.ok || json.success === false) throw new Error(JSON.stringify(json.data ?? json));
  return json.data;
}

async function fetchAllPages(initialUrl) {
  let allResults = [];
  let nextUrl = initialUrl;

  // Proteção contra loop infinito
  let loopCount = 0;
  const MAX_LOOPS = 50; 

  while (nextUrl && loopCount < MAX_LOOPS) {
    try {
      const data = await fetchJson(nextUrl);

      // O fetchJson já retorna o conteúdo de 'data' da resposta da API
      // Estrutura esperada em 'data': { count: 6, next: '...', results: [...] }

      if (data && data.results && Array.isArray(data.results)) {
        allResults = allResults.concat(data.results);

        // AQUI ESTÁ A CORREÇÃO PRINCIPAL:
        if (data.next) {
          // 1. Cria um objeto URL a partir do link 'next' retornado pelo backend
          // Ex: http://homolog.irridesk.com.br/api/farms/?limit=5&offset=5
          const urlObj = new URL(data.next);

          // 2. Força o uso da SUA baseUrl configurada (ex: localhost), ignorando o domínio que veio do backend
          // Isso resolve o problema de CORS/Auth entre ambientes diferentes
          // Removemos a barra final da CONFIG.baseUrl para evitar duplicidade (//)
          const currentBase = CONFIG.baseUrl.replace(/\/$/, ""); 
          
          // urlObj.pathname + urlObj.search pega "/api/farms/?limit=5&offset=5"
          nextUrl = `${currentBase}${urlObj.pathname}${urlObj.search}`;
        } else {
          nextUrl = null;
        }

      } else if (Array.isArray(data)) {
        // Caso a API retorne uma lista direta sem paginação
        allResults = data;
        nextUrl = null;
      } else {
        // Formato desconhecido, interrompe
        nextUrl = null;
      }

      loopCount++;

    } catch (err) {
      console.error("Erro na paginação:", err);
      // Se der erro no meio do caminho, retornamos o que já conseguimos coletar
      // em vez de quebrar tudo e não mostrar nada.
      return allResults.length > 0 ? allResults : []; 
    }
  }

  return allResults;
}

// -------------------------
// AUTH (MANUAL)
// -------------------------
async function handleLogin(e) {
  e.preventDefault(); 
  
  const email = els.emailInput.value;
  const password = els.passInput.value;

  if (!email || !password) return;

  els.submitLogin.disabled = true;
  els.submitLogin.textContent = "Autenticando...";
  els.loginError.style.display = "none";

  try {
    const response = await fetch(`${CONFIG.baseUrl}/api/accounts/signin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });

    const json = await response.json();

    if (!response.ok || json.success === false) {
      throw new Error(json.data || "Credenciais inválidas");
    }

    // Sucesso
    state.accessToken = json.data.access;
    els.loginOverlay.classList.add("hidden");
    
    // Iniciar carregamento de fazendas
    loadFarms();

  } catch (error) {
    console.error("Erro Login:", error);
    els.loginError.style.display = "block";
    els.loginError.innerHTML = `<i class="bi bi-exclamation-circle"></i> ${error.message || "Erro ao conectar"}`;
  } finally {
    els.submitLogin.disabled = false;
    els.submitLogin.textContent = "Entrar";
  }
}

function handleLogout() {
  window.location.reload();
}

// -------------------------
// SELECTION FLOW
// -------------------------

// 1. Carregar Fazendas
async function loadFarms() {
  try {
    els.farmSelect.innerHTML = "<option>Carregando...</option>";
    els.farmSelect.disabled = true;

    // Busca apenas a primeira página para o exemplo
    const results = await fetchAllPages(`${CONFIG.baseUrl}/api/farms/`);
    
    state.farms = results;
    
    // Renderizar
    els.farmSelect.innerHTML = `<option value="">Selecione a Fazenda</option>`;
    results.forEach(farm => {
      const opt = document.createElement("option");
      opt.value = farm.id;
      opt.textContent = farm.name;
      els.farmSelect.appendChild(opt);
    });
    
    els.farmSelect.disabled = false;

  } catch (error) {
    console.error(error);
    els.farmSelect.innerHTML = "<option>Erro ao carregar</option>";
  }
}

// 2. Listener Fazenda -> Carregar Equipamentos
els.farmSelect.addEventListener("change", async () => {
  const farmId = els.farmSelect.value;
  
  // Limpar equipamentos
  els.equipmentSelect.innerHTML = `<option value="">Selecione o Equipamento</option>`;
  els.equipmentSelect.disabled = true;
  els.btnSearch.disabled = true;
  state.currentIdAna = null;

  if (!farmId) return;

  try {
    els.equipmentSelect.innerHTML = "<option>Carregando...</option>";
    
    const results = await fetchAllPages(`${CONFIG.baseUrl}/api/equipments?farm__id=${farmId}`);

    state.equipments = results;

    els.equipmentSelect.innerHTML = `<option value="">Selecione o Equipamento</option>`;
    results.forEach(eq => {
      const opt = document.createElement("option");
      opt.value = eq.id;
      // Exibe Nome e gpkg_reference para ajudar na identificação
      opt.textContent = `${eq.name}`;
      // Salva o id_ana como data attribute para fácil acesso
      opt.dataset.ana = eq.id_ana;
      els.equipmentSelect.appendChild(opt);
    });

    els.equipmentSelect.disabled = false;

  } catch (error) {
    console.error(error);
    els.equipmentSelect.innerHTML = "<option>Erro ao carregar</option>";
  }
});

// 3. Listener Equipamento -> Habilitar Busca
els.equipmentSelect.addEventListener("change", () => {
  const eqId = els.equipmentSelect.value;
  
  if (!eqId) {
    state.currentIdAna = null;
    els.btnSearch.disabled = true;
    els.chartContainer.style.display = "none"; // Esconde gráfico
    return;
  }

  // Encontra o equipamento selecionado para pegar o gpkg_reference
  const selectedOption = els.equipmentSelect.options[els.equipmentSelect.selectedIndex];
  const anaRef = selectedOption.dataset.ana;

  if (anaRef) {
    state.currentIdAna = anaRef;
    els.btnSearch.disabled = false;
    loadRdiSerie(anaRef);
  } else {
    alert("Este equipamento não possui referência GPKG (ID ANA).");
    els.btnSearch.disabled = true;
  }
});

// -------------------------
// CHART LOGIC (NOVA)
// -------------------------

async function loadRdiSerie(idAna) {
  // Mostra container mas com loading (opcional, o ApexCharts anima a entrada)
  els.chartContainer.style.display = "block";
  
  try {
    const url = `${CONFIG.baseUrl}/api/equipments/tiff-files/rdi-serie/?id_ana=${idAna}`;
    // A API retorna diretamente a lista: [{date: '...', value: ...}, ...]
    const data = await fetchJson(url);

    if (!data || data.length === 0) {
       els.chartContainer.style.display = "none";
       return;
    }

    renderChart(data);

  } catch (error) {
    console.error("Erro ao carregar série histórica:", error);
    els.chartContainer.style.display = "none";
  }
}

function renderChart(serieData) {
  // 1. Formatar dados para formato [Timestamp, Valor]
  // O ApexCharts trabalha melhor com Timestamps no eixo X para Zoom
  const seriesFormatted = serieData.map(item => {
    return [new Date(item.date).getTime(), parseFloat(item.value)];
  });

  // 2. Configurações do Gráfico
  const options = {
    series: [{
      name: 'RDI',
      data: seriesFormatted
    }],
    chart: {
      type: 'area', // Área deixa visualmente mais rico que linha simples
      height: 250,
      fontFamily: 'Inter, sans-serif',
      toolbar: {
        show: true,
        tools: {
          download: false,
          selection: true,
          zoom: true,
          zoomin: true,
          zoomout: true,
          pan: true,
          reset: true
        },
        autoSelected: 'zoom' 
      },
      animations: {
        enabled: true
      }
    },
    colors: ['#00a99d'], // Cor primária do seu CSS
    dataLabels: {
      enabled: false // Desabilita label em cada ponto para não poluir
    },
    stroke: {
      curve: 'smooth',
      width: 2
    },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.7,
        opacityTo: 0.1, // Degradê suave
        stops: [0, 90, 100]
      }
    },
    xaxis: {
      type: 'datetime', // Importante para entender as datas
      tooltip: {
        enabled: false
      },
      labels: {
        format: 'dd/MM/yy'
      }
    },
    yaxis: {
      min: 0,
      max: 100, // Assumindo que RDI é porcentagem ou índice 0-100
      tickAmount: 5
    },
    tooltip: {
      x: {
        format: 'dd MMM yyyy'
      },
      y: {
        formatter: function (value) {
          return value.toFixed(2);
        }
      }
    },
    grid: {
      borderColor: '#f1f1f1',
    }
  };

  // 3. Renderização ou Atualização
  if (state.chartInstance) {
    // Se já existe, apenas atualiza os dados (animação suave)
    state.chartInstance.updateSeries([{
      data: seriesFormatted
    }]);
  } else {
    // Se não existe, cria novo
    state.chartInstance = new ApexCharts(document.querySelector("#rdiChart"), options);
    state.chartInstance.render();
  }
}


// -------------------------
// DATA FETCH (INDICES)
// -------------------------
async function searchAvailability() {
  if (!state.currentIdAna) return alert("Selecione um equipamento válido.");

  els.btnSearch.innerHTML = `<span class="spinner-border" style="width:1rem;height:1rem;"></span> Buscando...`;
  els.btnSearch.disabled = true;
  
  // Limpa UI anterior
  els.dateSelect.innerHTML = "<option>Carregando...</option>";
  els.dateSelect.disabled = true;
  els.bandsContainer.innerHTML = `<div style="color:var(--muted);">Carregando índices...</div>`;

  try {
    const urlAv = `${CONFIG.baseUrl}/api/equipments/tiff-files/availability/?id_ana=${state.currentIdAna}`;
    const items = await fetchJson(urlAv);

    state.availability = items;
    
    // Processar Bandas
    state.bandsByDate = new Map();
    const union = new Set();
    for (const it of items) {
      const arr = Array.isArray(it.indexes) ? it.indexes : [];
      const set = new Set(arr);
      state.bandsByDate.set(it.date, set);
      arr.forEach(b => union.add(b));
    }
    state.allBands = [...union].sort();

    renderDateSelector(items);
    
    if (items.length > 0) {
      setSelectedDate(items[0].date);
    } else {
      els.bandsContainer.innerHTML = "<div>Sem imagens disponíveis.</div>";
      resetImage();
    }

  } catch (error) {
    console.error(error);
    els.dateSelect.innerHTML = "<option>Erro</option>";
    els.bandsContainer.innerHTML = `<div style="color:red;">Erro: ${error.message}</div>`;
    resetImage();
  } finally {
    els.btnSearch.innerHTML = `<i class="bi bi-search"></i> Buscar Índices`;
    // Mantém habilitado para poder buscar novamente se trocar o equipamento
    els.btnSearch.disabled = false; 
  }
}

// -------------------------
// UI RENDERERS
// -------------------------
function renderDateSelector(items) {
  els.dateSelect.innerHTML = "";
  els.dateSelect.disabled = false;

  items.forEach(item => {
    const opt = document.createElement("option");
    opt.value = item.date;
    const [y, m, d] = item.date.split("-");
    opt.textContent = `${d}/${m}/${y}`;
    els.dateSelect.appendChild(opt);
  });
  els.dateSelect.onchange = () => setSelectedDate(els.dateSelect.value);
}

function renderBandGrid(date) {
  const availableBands = state.bandsByDate.get(date) || new Set();
  els.bandsContainer.innerHTML = "";

  const orderedList = [...BAND_ORDER];
  state.allBands.forEach(b => { if (!orderedList.includes(b)) orderedList.push(b); });

  orderedList.forEach(band => {
    const isAvailable = availableBands.has(band);
    const styleData = BAND_STYLE[band] || { class: "color-blue", icon: "bi-activity" };
    
    const btn = document.createElement("button");
    btn.className = `idx-btn ${styleData.class}`;
    btn.disabled = !isAvailable;
    btn.innerHTML = `<i class="bi ${styleData.icon}"></i> ${band}`;
    
    if (band === state.selectedBand) btn.classList.add("active");

    btn.onclick = () => { if (isAvailable) setSelectedBand(band); };
    els.bandsContainer.appendChild(btn);
  });
}

// -------------------------
// CORE LOGIC
// -------------------------
function setSelectedDate(dateStr) {
  state.selectedDate = dateStr;
  els.dateSelect.value = dateStr;

  const available = state.bandsByDate.get(dateStr);
  
  if (!state.selectedBand || !available.has(state.selectedBand)) {
    if (available.has("NDVI")) state.selectedBand = "NDVI";
    else state.selectedBand = available.values().next().value;
  }

  renderBandGrid(dateStr);

  loadRdi(dateStr);

  if (state.selectedBand) loadImage(dateStr, state.selectedBand);
}

function setSelectedBand(band) {
  state.selectedBand = band;
  renderBandGrid(state.selectedDate); 
  loadImage(state.selectedDate, band);
}

function resetImage() {
    els.pivotImage.style.opacity = "0";
    els.pivotImage.src = "";
    els.currentInfo.textContent = "Sem dados";
}

// 3. Adicione a nova função loadRdi (pode ser colocada antes de loadImage)
async function loadRdi(date) {
  // Mostra a seção se estiver oculta
  els.analysisSection.style.display = "block";
  
  // Estado de loading visual
  els.rdiValue.textContent = "--";
  els.rdiStatus.textContent = "Calculando...";
  els.metricCard.className = "metric-card"; // Reseta classes de cor

  try {
    const url = `${CONFIG.baseUrl}/api/equipments/tiff-files/rdi/?id_ana=${state.currentIdAna}&date=${date}`;
    
    // A função fetchJson já retorna o conteúdo de 'data' ({ rdi: 96.00... })
    const data = await fetchJson(url);
    
    if (data && data.rdi !== null && data.rdi !== undefined) {
      const valor = parseFloat(data.rdi);
      
      // Formatação
      els.rdiValue.textContent = valor.toFixed(2);
      
      // Lógica visual simples baseada no valor (exemplo hipotético)
      // RDI alto geralmente é bom (sem estresse hídrico), baixo é ruim.
      let statusText = "Nível Estável";
      let statusClass = "status-good";

      if (valor < 50) {
         statusText = "Atenção: Déficit Hídrico";
         statusClass = "status-danger";
      } else if (valor < 80) {
         statusText = "Alerta: Monitorar";
         statusClass = "status-warning";
      }

      els.rdiStatus.textContent = statusText;
      els.metricCard.classList.add(statusClass);

    } else {
      els.rdiValue.textContent = "N/A";
      els.rdiStatus.textContent = "Dados indisponíveis";
    }

  } catch (error) {
    console.error("Erro RDI:", error);
    els.rdiValue.textContent = "Erro";
    els.rdiStatus.textContent = "Falha ao obter índice";
  }
}

async function loadImage(date, band) {
  els.imgLoader.classList.remove("d-none");
  els.currentInfo.textContent = `${date} • ${band}`;
  els.pivotImage.style.opacity = "0.5"; 

  try {
    const url = `${CONFIG.baseUrl}/api/equipments/tiff-files/render/?id_ana=${state.currentIdAna}&date=${date}&band=${band}`;
    
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${state.accessToken}` }
    });

    if (!response.ok) throw new Error("Erro na imagem");

    const blob = await response.blob();
    
    if (state.lastObjectUrl) URL.revokeObjectURL(state.lastObjectUrl);
    const objectURL = URL.createObjectURL(blob);
    state.lastObjectUrl = objectURL;

    els.pivotImage.src = objectURL;
    els.pivotImage.onload = () => {
        els.pivotImage.style.opacity = "1";
        els.imgLoader.classList.add("d-none");
    };

  } catch (e) {
    console.error(e);
    els.currentInfo.textContent = "Erro ao carregar imagem";
    els.imgLoader.classList.add("d-none");
    els.pivotImage.style.opacity = "0";
  }
}

// -------------------------
// INIT
// -------------------------
document.addEventListener("DOMContentLoaded", () => {
  els.loginForm.addEventListener("submit", handleLogin);
  els.btnLogout.addEventListener("click", handleLogout);
  els.btnSearch.onclick = searchAvailability;
});