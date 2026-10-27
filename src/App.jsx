import { useState, useEffect, useRef } from 'react';
import { collection, getDocs, doc, getDoc, setDoc } from 'firebase/firestore';
import { db } from './firebase';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, LabelList } from 'recharts';
import './App.css';

const formatearDinero = (monto) => {
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    maximumFractionDigits: 0
  }).format(monto);
};

const obtenerDatosFecha = () => {
  const hoy = new Date();
  const año = hoy.getFullYear();
  const mesIndex = hoy.getMonth(); 
  const mes = mesIndex + 1; 
  return {
    año,
    mesIndex,
    idMes: `${año}-${mes.toString().padStart(2, '0')}`,
    totalDias: new Date(año, mes, 0).getDate(),
    diaHoy: hoy.getDate(),
    nombreMes: hoy.toLocaleString('es-AR', { month: 'long', year: 'numeric' })
  };
};

const obtenerNombreMesLegible = (idMes) => {
  try {
    const partes = idMes.split('-');
    if (partes.length !== 2) return idMes;
    const anio = parseInt(partes[0]);
    const mes = parseInt(partes[1]) - 1;
    const fecha = new Date(anio, mes, 1);
    if (isNaN(fecha.getTime())) return idMes;
    const nombre = fecha.toLocaleString('es-AR', { month: 'long', year: 'numeric' });
    return nombre.charAt(0).toUpperCase() + nombre.slice(1);
  } catch {
    return idMes;
  }
};

const obtenerNombreDia = (dia, año, mesIndex) => {
  const fecha = new Date(año, mesIndex, dia);
  const nombre = fecha.toLocaleDateString('es-AR', { weekday: 'long' });
  return `${nombre.charAt(0).toUpperCase() + nombre.slice(1)} ${dia}`;
};

const obtenerIconoClima = (codigo, probLluvia) => {
  if (probLluvia > 50 || (codigo >= 51 && codigo <= 67) || (codigo >= 80 && codigo <= 99)) return '🌧️';
  if (codigo >= 1 && codigo <= 3) return '⛅';
  if (codigo === 0) return '☀️';
  return '☁️';
};

const recalcularCurva = (dias, metaTotal) => {
  if (!dias || dias.length === 0) return [];
  let nuevosDias = [...dias];
  const pendientes = nuevosDias.filter(d => d && d.real === null);
  if (pendientes.length === 0) return nuevosDias;

  const acumuladoReal = nuevosDias.reduce((acc, d) => acc + (d?.real || 0), 0);
  const metaRestante = metaTotal - acumuladoReal;

  let sumaFactores = 0;
  let factor = 1;
  for (let i = 0; i < pendientes.length; i++) {
    sumaFactores += factor;
    factor *= 0.97;
  }

  let nuevaBase = metaRestante / (sumaFactores || 1);
  let indexPendiente = 0;

  for (let i = 0; i < nuevosDias.length; i++) {
    if (nuevosDias[i] && nuevosDias[i].real === null) {
      if (indexPendiente === pendientes.length - 1) {
        const acumuladoPrevio = nuevosDias
          .filter((_, idx) => idx !== i)
          .reduce((acc, d) => acc + (d?.real !== null ? (d?.real || 0) : (d?.esperado || 0)), 0);
        nuevosDias[i].esperado = Math.max(0, Math.round(metaTotal - acumuladoPrevio));
      } else {
        nuevosDias[i].esperado = Math.round(nuevaBase);
        nuevaBase *= 0.97;
      }
      indexPendiente++;
    }
  }
  return nuevosDias;
};

const generarMesDinamico = (metaTotal, totalDias) => {
  let diasIniciales = [];
  for (let i = 1; i <= totalDias; i++) {
    diasIniciales.push({ dia: i, esperado: 0, real: null });
  }
  return recalcularCurva(diasIniciales, metaTotal);
};

// Excedente acumulado (criterio propio):
//   (suma de totales de días verdes: real >= meta) - (suma de totales de días rojos: real < meta) - (suma de metas de todos los días cerrados).
// Los días en $0 no son verdes ni rojos, pero su meta igual entra en la resta final.
const calcularExcedenteAcumulado = (dias) => {
  let verdes = 0;
  let rojos = 0;
  let metas = 0;
  dias.forEach(d => {
    if (!d || d.real === null || d.real === undefined) return;
    const real = Number(d.real) || 0;
    const meta = Number(d.esperado) || 0;
    metas += meta;
    if (real >= meta) verdes += real;
    else rojos += real;
  });
  return verdes - rojos - metas;
};

const obtenerProximoDiaPendiente = (dias) => dias.find(d => d && d.real === null) || null;

const obtenerDiaFrancoAsignado = (dias) => dias.find(d => d && d.esFranco && Number(d.real) === 0) || null;

// Hay franco disponible cuando el excedente acumulado alcanza la meta del próximo día pendiente.
const calcularSiPuedeFranco = (dias) => {
  const proximo = obtenerProximoDiaPendiente(dias);
  if (!proximo || proximo.esperado <= 0) return false;
  return calcularExcedenteAcumulado(dias) >= proximo.esperado;
};

const esDiaNoTrabajado = (d) => d && d.real != null && Number(d.real) === 0;

// ===== Helpers de Jornada =====
const horaActual = () => {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
};

const horaAMinutos = (hora) => {
  if (!hora || !/^\d{1,2}:\d{2}$/.test(hora)) return null;
  const [h, m] = hora.split(':').map(Number);
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
};

const eventosJornada = (d) => {
  if (!d) return [];
  const eventos = [];
  if (d.inicio && d.inicio.hora) eventos.push({ tipo: 'inicio', ...d.inicio });
  (Array.isArray(d.pausas) ? d.pausas : []).forEach(p => { if (p && p.hora) eventos.push(p); });
  if (d.fin && d.fin.hora) eventos.push({ tipo: 'fin', ...d.fin });
  return eventos;
};

const calcularHorasJornada = (d, hastaHora = null) => {
  let totalMin = 0;
  let desdeMin = null;
  eventosJornada(d).forEach(ev => {
    if (ev.tipo === 'inicio' || ev.tipo === 'retomar') {
      desdeMin = horaAMinutos(ev.hora);
    } else if ((ev.tipo === 'pausa' || ev.tipo === 'fin') && desdeMin !== null) {
      const hastaMin = horaAMinutos(ev.hora);
      if (hastaMin !== null && hastaMin > desdeMin) totalMin += hastaMin - desdeMin;
      desdeMin = null;
    }
  });
  if (hastaHora && desdeMin !== null) {
    const hastaMin = horaAMinutos(hastaHora);
    if (hastaMin !== null && hastaMin > desdeMin) totalMin += hastaMin - desdeMin;
  }
  return Math.round((totalMin / 60) * 100) / 100;
};

const ultimoKmJornada = (d) => {
  const evs = eventosJornada(d);
  for (let i = evs.length - 1; i >= 0; i--) {
    const km = Number(evs[i].km);
    if (!isNaN(km) && km > 0) return km;
  }
  return null;
};

const obtenerUltimoKmGlobal = (arrDias, diaLimite) => {
  for (let i = diaLimite - 2; i >= 0; i--) {
    const km = ultimoKmJornada(arrDias[i]);
    if (km !== null) return km;
  }
  return null;
};

// Los montos guardados en cada pausa son el ACUMULADO del día: se toma el último registrado.
const acumuladoJornada = (d) => {
  const pausas = Array.isArray(d?.pausas) ? d.pausas : [];
  for (let i = pausas.length - 1; i >= 0; i--) {
    if (pausas[i] && pausas[i].tipo === 'pausa') {
      const uber = Number(pausas[i].uber) || 0;
      const didi = Number(pausas[i].didi) || 0;
      return { uber, didi, total: uber + didi };
    }
  }
  return { uber: 0, didi: 0, total: 0 };
};

const tieneEventosJornada = (d) => !!(d && (d.inicio || d.fin || (Array.isArray(d.pausas) && d.pausas.length > 0)));

const formatearKm = (km) => `${new Intl.NumberFormat('es-AR').format(km)} km`;

const generarCurvaIdeal = (metaTotal, totalDias) => {
  if (!totalDias || totalDias <= 0) return [];
  let sumaFactores = 0;
  let factor = 1;
  for (let i = 0; i < totalDias; i++) {
    sumaFactores += factor;
    factor *= 0.97;
  }
  let base = metaTotal / (sumaFactores || 1);
  const curva = [];
  let acumulado = 0;
  for (let i = 0; i < totalDias; i++) {
    acumulado += (i === totalDias - 1)
      ? Math.max(0, Math.round(metaTotal - acumulado))
      : Math.round(base);
    curva.push(acumulado);
    base *= 0.97;
  }
  return curva;
};

const CATEGORIAS_GASTO_PREDETERMINADAS = [
  'Combustible', 'Comida', 'Vivienda', 'Transporte', 'Servicios',
  'Seguros', 'Mantenimiento', 'Uber', 'DiDi', 'Propina', 'Otros'
];

const SUBCATEGORIAS_GASTO_PREDETERMINADAS = {
  'Combustible': ['Nafta', 'GNC'],
  'Comida': ['Supermercado', 'Restaurante', 'Delivery'],
  'Vivienda': ['Alquiler', 'Expensas', 'Impuestos'],
  'Transporte': ['Estacionamiento', 'Peaje', 'Transporte público'],
  'Servicios': ['Luz', 'Agua', 'Gas', 'Internet', 'Celular'],
  'Seguros': ['Auto', 'Vida', 'Celular'],
  'Mantenimiento': ['Auto', 'Hogar'],
  'Uber': [],
  'DiDi': [],
  'Propina': ['Uber', 'DiDi'],
  'Otros': []
};

const CATEGORIAS_INGRESO_PREDETERMINADAS = [
  'Sueldo', 'Propina', 'Otros'
];

const SUBCATEGORIAS_INGRESO_PREDETERMINADAS = {
  'Sueldo': ['Uber', 'DiDi', 'Extra'],
  'Propina': ['Uber', 'DiDi'],
  'Otros': []
};


const BILLETERAS_PREDETERMINADAS = [
  'Mercado Pago', 'Naranja X', 'Ualá', 'Personal Pay', 'Brubank', 'Cuenta DNI', 'Efectivo', 'Otros'
];

const hoyComoStr = () => {
  const hoy = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(hoy.getDate())}`;
};

const esRepetitivo = (mov) => mov && (mov.seRepite || mov.esCuotas);

const obtenerCuotaParaMes = (mov, mesId) => {
  if (!mov || !esRepetitivo(mov) || !mov.fecha) return null;
  if (Array.isArray(mov.cuotasOmitidas) && mov.cuotasOmitidas.includes(mesId)) return null;
  const [ay, am] = mov.fecha.slice(0, 7).split('-').map(Number);
  const [my, mm] = mesId.split('-').map(Number);
  if (mov.frecuencia === 'fijo') {
    if (my < ay || (my === ay && mm < am)) return null;
    return 1;
  }
  const ca = mov.cuotaActual || 1;
  const tc = mov.totalCuotas || 1;
  let n;
  if (mov.frecuencia === 'anual') {
    n = ca + (my - ay);
  } else {
    n = ca + (my - ay) * 12 + (mm - am);
  }
  return (n >= 1 && n <= tc) ? n : null;
};

const valorMovimientoEnMes = (mov, mesId) => {
  if (!mov) return 0;
  if (!esRepetitivo(mov)) return Number(mov.monto) || 0;
  if (obtenerCuotaParaMes(mov, mesId) === null) return 0;
  if (mov.frecuencia === 'fijo') return Number(mov.monto) || 0;
  if (mov.montoEs === 'total') {
    const tc = mov.totalCuotas || 1;
    return Math.round((Number(mov.montoTotal != null ? mov.montoTotal : mov.monto) || 0) / tc);
  }
  return Number(mov.monto) || 0;
};

const textoRepeticion = (mov) => {
  if (!mov || !esRepetitivo(mov)) return '';
  if (mov.frecuencia === 'fijo') {
    return `Fijo mensual de ${formatearDinero(mov.montoTotal != null ? mov.montoTotal : mov.monto)}`;
  }
  const tc = mov.totalCuotas || 1;
  const frec = mov.frecuencia === 'anual' ? 'anuales' : 'mensuales';
  if (mov.montoEs === 'total') {
    return `${tc} cuotas ${frec} · total ${formatearDinero(mov.montoTotal != null ? mov.montoTotal : mov.monto)}`;
  }
  return `${tc} cuotas ${frec} de ${formatearDinero(mov.monto)}`;
};

// Suma el valor total aportado por un movimiento a lo largo de todos sus meses
// activos hasta el mes actual (inclusive). Para movimientos no repetitivos
// aporta una sola vez su monto.
const contribucionTotalMovimiento = (mov, mesActual) => {
  if (!mov) return 0;
  if (!esRepetitivo(mov)) return Number(mov.monto) || 0;
  const [ay, am] = (mov.fecha || '').slice(0, 7).split('-').map(Number);
  if (!ay || !am) return Number(mov.monto) || 0;
  const [cy, cm] = mesActual.split('-').map(Number);
  let total = 0;
  let yy = ay, mm = am;
  let guard = 0;
  while ((yy < cy || (yy === cy && mm <= cm)) && guard < 5000) {
    const mesId = `${String(yy).padStart(4, '0')}-${String(mm).padStart(2, '0')}`;
    total += valorMovimientoEnMes(mov, mesId);
    mm += 1;
    if (mm > 12) { mm = 1; yy += 1; }
    guard += 1;
  }
  return total;
};

// Saldo actual de una billetera: ingresos - gastos (± transferencias) acumulados sobre todos sus movimientos.
// Los movimientos marcados como "no realizada" (pendientes) aún no movieron dinero y no afectan el saldo.
const saldoBilletera = (billetera, movimientos, mesActual) => {
  return movimientos
    .filter(m => {
      if (m.realizada === false) return false;
      if (m.tipo === 'transfer') {
        // Una transferencia afecta el saldo del origen (sale) y del destino (entra)
        return m.billetera === billetera || m.billeteraDestino === billetera;
      }
      return m.billetera === billetera;
    })
    .reduce((acc, m) => {
      const v = contribucionTotalMovimiento(m, mesActual) || 0;
      if (m.tipo === 'transfer') {
        return m.billetera === billetera ? acc - v : acc + v;
      }
      return m.tipo === 'ingreso' ? acc + v : acc - v;
    }, 0);
};


const CampoAutocomplete = ({ label, value, onChange, opciones, placeholder }) => {
  const [abierto, setAbierto] = useState(false);

  return (
    <div>
      <label className="block text-sm font-medium text-gray-600 mb-1">{label}</label>
      <input
        type="text"
        readOnly
        value={value || ''}
        onChange={() => {}}
        onClick={() => setAbierto(true)}
        onFocus={() => setAbierto(true)}
        onBlur={() => setTimeout(() => setAbierto(false), 150)}
        placeholder={placeholder}
        className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
      />
      {abierto && (
        <div className="border border-gray-200 bg-white shadow-lg mt-1 max-h-40 overflow-y-auto rounded-none">
          {opciones.map(o => (
            <button
              key={o}
              type="button"
              onMouseDown={() => { onChange(o); setAbierto(false); }}
              className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-gray-100"
            >
              {o}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const MiniCalculadora = ({ abierta, onUsar, onCerrar }) => {
  const [expr, setExpr] = useState('');

  if (!abierta) return null;

  const teclas = [
    '7', '8', '9', '/',
    '4', '5', '6', '*',
    '1', '2', '3', '-',
    '0', '.', 'C', '+'
  ];

  const pulsar = (t) => {
    if (t === 'C') { setExpr(''); return; }
    setExpr(e => e + t);
  };

  const calcular = () => {
    try {
      const res = Function(`"use strict"; return (${expr});`)();
      if (typeof res === 'number' && isFinite(res)) {
        onUsar(res);
      }
    } catch {
      /* ignorar expresiones inválidas */
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center" onClick={onCerrar}>
      <div className="bg-white p-4 w-72 rounded-none shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="text-right mb-3 px-2 py-3 border border-gray-200 bg-gray-50 text-2xl font-bold text-slate-800 min-h-[3rem] break-all">
          {expr || '0'}
        </div>
        <div className="grid grid-cols-4 gap-2">
          {teclas.map(t => (
            <button
              key={t}
              type="button"
              onClick={() => pulsar(t)}
              className={`py-3 text-lg rounded-none ${t === 'C' ? 'bg-red-500 text-white' : 'bg-gray-100 text-slate-800'} active:bg-gray-300`}
            >
              {t}
            </button>
          ))}
          <button
            type="button"
            onClick={calcular}
            className="col-span-4 py-3 text-lg font-bold rounded-none bg-slate-800 text-white active:bg-slate-600"
          >
            = Usar este valor
          </button>
        </div>
      </div>
    </div>
  );
};

const HorasTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="p-3 rounded-none bg-white/90 backdrop-blur-sm border border-gray-200 text-xs shadow-sm">
        <p className="font-bold text-slate-800 mb-1">Día {label}</p>
        <p className="text-purple-700 font-semibold">⏱️ {data.horas} hs trabajadas</p>
        <p className="text-green-600 font-semibold">💰 {formatearDinero(data.total)}</p>
      </div>
    );
  }
  return null;
};

const ProgresoTooltip = ({ active, payload, label }) => {
  if (!active || !payload || payload.length === 0) return null;
  const puntoIdeal = payload.find(p => p.dataKey === 'Esperado');
  const puntoReal = payload.find(p => p.dataKey === 'Real');
  const otros = payload.filter(p => p.dataKey !== 'Esperado' && p.dataKey !== 'Real' && p.value != null);
  const dif = (puntoReal && puntoReal.value != null && puntoIdeal)
    ? puntoReal.value - puntoIdeal.value
    : null;
  return (
    <div className="p-3 rounded-none bg-white/90 backdrop-blur-sm border border-gray-200 text-xs shadow-sm">
      <p className="font-bold text-slate-800 mb-1">Día {label}</p>
      {puntoIdeal && (
        <p className="text-slate-500 font-semibold">🎯 Ideal: {formatearDinero(puntoIdeal.value)}</p>
      )}
      {puntoReal && puntoReal.value != null ? (
        <p className="text-blue-600 font-semibold">💰 Real: {formatearDinero(puntoReal.value)}</p>
      ) : (
        <p className="text-gray-400 font-semibold">Sin cargar aún</p>
      )}
      {otros.map(o => (
        <p key={o.dataKey} style={{ color: o.stroke }} className="font-semibold">{o.name}: {formatearDinero(o.value)}</p>
      ))}
      {dif != null && (
        <p className={`font-bold mt-1 ${dif >= 0 ? 'text-green-600' : 'text-red-500'}`}>
          {dif >= 0 ? '🟢 +' : '🔴 −'}{formatearDinero(Math.abs(dif))} vs plan
        </p>
      )}
    </div>
  );
};

const DineroHoraTooltip = ({ active, payload, label }) => {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    return (
      <div className="p-3 rounded-none bg-white/90 backdrop-blur-sm border border-gray-200 text-xs shadow-sm">
        <p className="font-bold text-slate-800 mb-1">Día {label}</p>
        <p className="text-teal-700 font-semibold">💵 {formatearDinero(data.dineroHora)}/hs</p>
        <p className="text-gray-500">⏱️ {data.horas} hs → 💰 {formatearDinero(data.total)}</p>
      </div>
    );
  }
  return null;
};

function App() {
  const [metaTotal, setMetaTotal] = useState(3000000);
  const [dias, setDias] = useState([]);
  const [cargando, setCargando] = useState(true);
  
  const [vistaActual, setVistaActual] = useState('planificador');
  const [seccion, setSeccion] = useState('dashboard');
  const [tabAnimClass, setTabAnimClass] = useState('');
  const [modoGraficoGanancia, setModoGraficoGanancia] = useState('hora');
  const [modoConfig, setModoConfig] = useState(false);
  // Estados del sistema de jornadas (iniciar / pausar-retomar / finalizar)
  const [showIniciarModal, setShowIniciarModal] = useState(false);
  const [jornadaHoraInicio, setJornadaHoraInicio] = useState('');
  const [jornadaKmInicio, setJornadaKmInicio] = useState('');

  const [showPausaRetomarModal, setShowPausaRetomarModal] = useState(false);
  const [modoPausaRetomar, setModoPausaRetomar] = useState('pausar');
  const [pausaUber, setPausaUber] = useState('');
  const [pausaDidi, setPausaDidi] = useState('');
  const [pausaHora, setPausaHora] = useState('');
  const [pausaKm, setPausaKm] = useState('');

  const [showFinalizarModal, setShowFinalizarModal] = useState(false);
  const [finUber, setFinUber] = useState('');
  const [finDidi, setFinDidi] = useState('');
  const [finHora, setFinHora] = useState('');
  const [finKm, setFinKm] = useState('');

  const [diaEnEdicion, setDiaEnEdicion] = useState(null);
  const [edicionUber, setEdicionUber] = useState('');
  const [edicionDidi, setEdicionDidi] = useState('');
  const [edicionHoras, setEdicionHoras] = useState('');
  const [edicionUberParcial, setEdicionUberParcial] = useState('');
  const [edicionDidiParcial, setEdicionDidiParcial] = useState('');
  const [edicionHorasParcial, setEdicionHorasParcial] = useState('');

  // Copia editable de los eventos de la jornada para el editor del historial
  const [editJornadaData, setEditJornadaData] = useState(null);

  const [climaPronostico, setClimaPronostico] = useState({});
  const [climaPorHora, setClimaPorHora] = useState({});
  const [diaModalSeleccionado, setDiaModalSeleccionado] = useState(null); 

  // Sistema de franco por excedente
  const [showFrancoModal, setShowFrancoModal] = useState(false);
  const [diaFrancoTemporal, setDiaFrancoTemporal] = useState(null);

  const [mesesHistoricos, setMesesHistoricos] = useState({});
  const [mesesComparados, setMesesComparados] = useState([]); 
  const [mesSeleccionadoDetalle, setMesSeleccionadoDetalle] = useState(null);

  // ===== Sección Vehículo =====
  const [registrosVehiculo, setRegistrosVehiculo] = useState([]);
  const [showCombustibleModal, setShowCombustibleModal] = useState(false);
  const [combFecha, setCombFecha] = useState('');
  const [combValor, setCombValor] = useState('');
  const [combKm, setCombKm] = useState('');
  const [combGnc, setCombGnc] = useState(true);
  const [combNafta, setCombNafta] = useState(false);
  const [showReparacionModal, setShowReparacionModal] = useState(false);
  const [repFecha, setRepFecha] = useState('');
  const [repValor, setRepValor] = useState('');
  const [repKm, setRepKm] = useState('');
  const [repTipo, setRepTipo] = useState('');
  const [showMantenimientoModal, setShowMantenimientoModal] = useState(false);
  const [mantFecha, setMantFecha] = useState('');
  const [mantValor, setMantValor] = useState('');
  const [mantKm, setMantKm] = useState('');
  const [mantTipo, setMantTipo] = useState('');
  const [mantPeriodico, setMantPeriodico] = useState(false);
  const [mantCadaKm, setMantCadaKm] = useState('');
  const [kmAuto, setKmAuto] = useState(0);
  const [filtroComb, setFiltroComb] = useState(true);
  const [filtroRep, setFiltroRep] = useState(true);
  const [filtroMant, setFiltroMant] = useState(true);
  const [subVehiculo, setSubVehiculo] = useState('inicio');

  // ===== Sección Finanzas =====
  const [subFinanzas, setSubFinanzas] = useState('inicio');
  const [detalleFinanzas, setDetalleFinanzas] = useState(null);
  const [mesFinanzas, setMesFinanzas] = useState(null);
  const [billeteraSeleccionada, setBilleteraSeleccionada] = useState(null);
  const [ajusteSaldoAbierto, setAjusteSaldoAbierto] = useState(false);
  const [ajusteSaldoValor, setAjusteSaldoValor] = useState('');
  const [transferenciaAbierta, setTransferenciaAbierta] = useState(false);
  const [transferenciaOrigen, setTransferenciaOrigen] = useState(null);
  const [transferenciaDestino, setTransferenciaDestino] = useState('');
  const [transferenciaMonto, setTransferenciaMonto] = useState('');
  const [nuevaBilleteraFinanzas, setNuevaBilleteraFinanzas] = useState('');
  const [movimientosFinanzas, setMovimientosFinanzas] = useState([]);
  const [categoriasGasto, setCategoriasGasto] = useState(CATEGORIAS_GASTO_PREDETERMINADAS);
  const [subcategoriasGasto, setSubcategoriasGasto] = useState(SUBCATEGORIAS_GASTO_PREDETERMINADAS);
  const [categoriasIngreso, setCategoriasIngreso] = useState(CATEGORIAS_INGRESO_PREDETERMINADAS);
  const [subcategoriasIngreso, setSubcategoriasIngreso] = useState(SUBCATEGORIAS_INGRESO_PREDETERMINADAS);
  const [billeterasFinanzas, setBilleterasFinanzas] = useState(BILLETERAS_PREDETERMINADAS);
  const [billeterasReserva, setBilleterasReserva] = useState([]);
  const [billeterasDistribucion, setBilleterasDistribucion] = useState({});
  const [showGastoModal, setShowGastoModal] = useState(false);
  const [showIngresoModal, setShowIngresoModal] = useState(false);
  const [showConfigModal, setShowConfigModal] = useState(false);
  const [movEnEdicion, setMovEnEdicion] = useState(null);
  const [movConfirmarBorrar, setMovConfirmarBorrar] = useState(null);
  const [movConfirmarBorrarMes, setMovConfirmarBorrarMes] = useState(null);
  const [gastoMonto, setGastoMonto] = useState('');
  const [gastoDescripcion, setGastoDescripcion] = useState('');
  const [gastoSeRepite, setGastoSeRepite] = useState(false);
  const [gastoCuota, setGastoCuota] = useState('1');
  const [gastoTotalCuotas, setGastoTotalCuotas] = useState('');
  const [gastoFrecuencia, setGastoFrecuencia] = useState('mensual');
  const [gastoMontoEs, setGastoMontoEs] = useState('cuota');
  const [gastoFecha, setGastoFecha] = useState(hoyComoStr());
  const [gastoRealizada, setGastoRealizada] = useState(true);
  const [gastoCategoria, setGastoCategoria] = useState('');
  const [gastoSubcategoria, setGastoSubcategoria] = useState('');
  const [gastoBilletera, setGastoBilletera] = useState('');
  const [ingresoMonto, setIngresoMonto] = useState('');
  const [ingresoDescripcion, setIngresoDescripcion] = useState('');
  const [ingresoSeRepite, setIngresoSeRepite] = useState(false);
  const [ingresoCuota, setIngresoCuota] = useState('1');
  const [ingresoTotalCuotas, setIngresoTotalCuotas] = useState('');
  const [ingresoFrecuencia, setIngresoFrecuencia] = useState('mensual');
  const [ingresoMontoEs, setIngresoMontoEs] = useState('cuota');
  const [ingresoFecha, setIngresoFecha] = useState(hoyComoStr());
  const [ingresoRealizada, setIngresoRealizada] = useState(true);
  const [ingresoCategoria, setIngresoCategoria] = useState('');
  const [ingresoSubcategoria, setIngresoSubcategoria] = useState('');
  const [ingresoBilletera, setIngresoBilletera] = useState('');
  const [ingresoDistribuir, setIngresoDistribuir] = useState(false);
  const [ingresoDistribucion, setIngresoDistribucion] = useState([]);
  const [calcAbierta, setCalcAbierta] = useState(false);
  const [calcDestino, setCalcDestino] = useState('gasto');
  const [calcSeq, setCalcSeq] = useState(0);
  const [tabConfig, setTabConfig] = useState('categorias');
  const [tipoCategoriaConfig, setTipoCategoriaConfig] = useState('gasto');
  const [precioNafta, setPrecioNafta] = useState('');
  const [precioGnc, setPrecioGnc] = useState('');
  const [nuevaCategoria, setNuevaCategoria] = useState('');
  const [nuevaSubcategoria, setNuevaSubcategoria] = useState('');
  const [categoriaEnEdicion, setCategoriaEnEdicion] = useState('');

  const [nuevaMeta, setNuevaMeta] = useState(3000000);
  const [zoomDias, setZoomDias] = useState(31);
  const [zoomInicio, setZoomInicio] = useState(0);

  const touchRef = useRef({ startX: 0, startY: 0, endX: 0, endY: 0 });

  const fecha = obtenerDatosFecha();
  const diaSeleccionado = fecha.diaHoy;
  const idMesActivo = mesFinanzas || fecha.idMes;

  const cambiarMesFinanzas = (offset) => {
    const partes = idMesActivo.split('-').map(Number);
    const d = new Date(partes[0], partes[1] - 1 + offset, 1);
    setMesFinanzas(`${d.getFullYear()}-${(d.getMonth() + 1).toString().padStart(2, '0')}`);
  };

  const tabs = ['planificador', 'graficos', 'historial'];
  const tabsVehiculo = ['inicio', 'registros', 'graficos'];

  const cambiarVista = (nuevaVista) => {
    const fromIndex = tabs.indexOf(vistaActual);
    const toIndex = tabs.indexOf(nuevaVista);
    const dir = toIndex > fromIndex ? 'right' : 'left';
    setTabAnimClass(`tab-slide-${dir}`);
    setVistaActual(nuevaVista);
    setModoConfig(false);
    setMesSeleccionadoDetalle(null);
  };

  const cambiarSeccion = (nuevaSeccion) => {
    setTabAnimClass('');
    setSeccion(nuevaSeccion);
    if (nuevaSeccion === 'finanzas') {
      setSubFinanzas('inicio');
      setDetalleFinanzas(null);
      setBilleteraSeleccionada(null);
    }
  };

  useEffect(() => {
    if (!tabAnimClass) return;
    const t = setTimeout(() => setTabAnimClass(''), 250);
    return () => clearTimeout(t);
  }, [tabAnimClass]);

  const handleTouchStart = (e) => {
    touchRef.current.startX = e.touches[0].clientX;
    touchRef.current.startY = e.touches[0].clientY;
    touchRef.current.endX = e.touches[0].clientX;
    touchRef.current.endY = e.touches[0].clientY;
  };

  const handleTouchMove = (e) => {
    touchRef.current.endX = e.touches[0].clientX;
    touchRef.current.endY = e.touches[0].clientY;
    const diffX = touchRef.current.startX - touchRef.current.endX;
    const diffY = Math.abs(touchRef.current.startY - touchRef.current.endY);
    if (Math.abs(diffX) > 10 && diffY < 50) {
      e.preventDefault();
    }
  };

  const handleTouchEnd = () => {
    const { startX, startY, endX, endY } = touchRef.current;
    if (startX === endX && startY === endY) return;
    const diffX = startX - endX;
    const diffY = Math.abs(startY - endY);
    const horizontalThreshold = 50;
    const verticalThreshold = 50;
    if (Math.abs(diffX) > horizontalThreshold && diffY < verticalThreshold) {
      if (seccion === 'trabajo') {
        const currentIndex = tabs.indexOf(vistaActual);
        if (diffX > 0 && currentIndex < tabs.length - 1) {
          cambiarVista(tabs[currentIndex + 1]);
        } else if (diffX < 0 && currentIndex > 0) {
          cambiarVista(tabs[currentIndex - 1]);
        }
      } else if (seccion === 'vehiculo') {
        const currentIndex = tabsVehiculo.indexOf(subVehiculo);
        if (diffX > 0 && currentIndex < tabsVehiculo.length - 1) {
          setSubVehiculo(tabsVehiculo[currentIndex + 1]);
        } else if (diffX < 0 && currentIndex > 0) {
          setSubVehiculo(tabsVehiculo[currentIndex - 1]);
        }
      }
    }
    touchRef.current = { startX: 0, startY: 0, endX: 0, endY: 0 };
  };

  useEffect(() => {
    const cargarDatosYClima = async () => {
      try {
        const docRef = doc(db, 'planificador', fecha.idMes);
        const docSnap = await getDoc(docRef);

        let diasPlanificador = [];
        if (docSnap.exists()) {
          const datos = docSnap.data();
          const meta = datos.metaTotal || 3000000;
          setMetaTotal(meta);
          setNuevaMeta(meta);
          diasPlanificador = (datos.dias || []).map(d => ({ ...d, real: d.real ?? null, esperado: d.esperado || 0 }));
          setDias(diasPlanificador);
        } else {
          const diasNuevos = generarMesDinamico(3000000, fecha.totalDias);
          diasPlanificador = diasNuevos;
          setDias(diasNuevos);
          await setDoc(docRef, { metaTotal: 3000000, dias: diasNuevos });
        }

        const querySnapshot = await getDocs(collection(db, 'planificador'));
        let historicos = {};
        querySnapshot.forEach((docItem) => {
          if (/^\d{4}-\d{2}$/.test(docItem.id)) {
            historicos[docItem.id] = docItem.data();
          }
        });
        setMesesHistoricos(historicos);

        const vehRef = doc(db, 'vehiculo', 'registros');
        const vehSnap = await getDoc(vehRef);
        const diasParaKm = diasPlanificador;
        const ultKmTrabajo = obtenerUltimoKmGlobal(diasParaKm, diasParaKm.length + 1);
        if (vehSnap.exists()) {
          const dataVeh = vehSnap.data();
          let regsVeh = dataVeh.registros || [];
          const maxRegKmBase = regsVeh.reduce((m, r) => Math.max(m, Number(r.km) || 0), 0);
          const kmAutoCalculado = Math.max(maxRegKmBase, ultKmTrabajo || 0);
          const kmAutoCorrupto = Boolean(dataVeh.kmAuto > kmAutoCalculado);
          const gruposPend = new Map();
          regsVeh.forEach((r, i) => {
            if (r.tipo === 'mantenimiento' && r.periodico && r.cadaKm && !r.hecho) {
              const key = `${r.tipoMantenimiento}|${r.cadaKm}`;
              if (!gruposPend.has(key)) gruposPend.set(key, []);
              gruposPend.get(key).push(i);
            }
          });
          const indicesDuplicados = new Set();
          gruposPend.forEach((indices) => {
            if (indices.length > 1) {
              const mejor = indices.reduce((a, b) =>
                (Number(regsVeh[a].km) || 0) >= (Number(regsVeh[b].km) || 0) ? a : b, indices[0]);
              indices.forEach(i => { if (i !== mejor) indicesDuplicados.add(i); });
            }
          });
          if (indicesDuplicados.size > 0) {
            regsVeh = regsVeh.filter((_, i) => !indicesDuplicados.has(i));
          }
          const kmBasePorGrupo = new Map();
          regsVeh.forEach((r) => {
            if (r.tipo === 'mantenimiento' && r.periodico && r.cadaKm && r.hecho) {
              const key = `${r.tipoMantenimiento}|${r.cadaKm}`;
              const kmHecho = Number(r.km) || 0;
              if (!kmBasePorGrupo.has(key) || kmHecho > kmBasePorGrupo.get(key)) {
                kmBasePorGrupo.set(key, kmHecho);
              }
            }
          });
          let kmReparados = false;
          if (kmBasePorGrupo.size > 0) {
            regsVeh = regsVeh.map((r) => {
              if (r.tipo === 'mantenimiento' && r.periodico && r.cadaKm && !r.hecho) {
                const key = `${r.tipoMantenimiento}|${r.cadaKm}`;
                if (kmBasePorGrupo.has(key) && (Number(r.km) || 0) !== kmBasePorGrupo.get(key)) {
                  kmReparados = true;
                  return { ...r, km: kmBasePorGrupo.get(key) };
                }
              }
              return r;
            });
          }
          if (indicesDuplicados.size > 0 || kmReparados || kmAutoCorrupto) {
            await setDoc(doc(db, 'vehiculo', 'registros'), { registros: regsVeh, kmAuto: kmAutoCalculado });
          }
          setRegistrosVehiculo(regsVeh);
          setKmAuto(kmAutoCalculado);
        } else {
          setRegistrosVehiculo([]);
          setKmAuto(ultKmTrabajo || 0);
        }

        // Cargar movimientos de finanzas
        try {
          const finRef = doc(db, 'finanzas', 'movimientos');
          const finSnap = await getDoc(finRef);
          if (finSnap.exists()) {
            setMovimientosFinanzas(finSnap.data().movimientos || []);
          } else {
            setMovimientosFinanzas([]);
          }
        } catch (e) {
          console.error("Error al cargar finanzas:", e);
        }

        // Cargar configuración de finanzas (categorías, subcategorías, billeteras y combustible)
        try {
          const cfgRef = doc(db, 'finanzas', 'config');
          const cfgSnap = await getDoc(cfgRef);
          if (cfgSnap.exists()) {
            const cfg = cfgSnap.data();
            // Categorías de gastos: usar las guardadas o hacer retrofit de la lista antigua única
            const catsGasto = Array.isArray(cfg.categoriasGasto) && cfg.categoriasGasto.length
              ? cfg.categoriasGasto
              : (Array.isArray(cfg.categorias) && cfg.categorias.length ? cfg.categorias : CATEGORIAS_GASTO_PREDETERMINADAS);
            const catsIngreso = Array.isArray(cfg.categoriasIngreso) && cfg.categoriasIngreso.length
              ? cfg.categoriasIngreso
              : CATEGORIAS_INGRESO_PREDETERMINADAS;
            setCategoriasGasto(catsGasto);
            setCategoriasIngreso(catsIngreso);
            setBilleterasFinanzas(Array.isArray(cfg.billeteras) && cfg.billeteras.length ? cfg.billeteras : BILLETERAS_PREDETERMINADAS);
            setBilleterasReserva(Array.isArray(cfg.billeterasReserva) ? cfg.billeterasReserva : []);
            setBilleterasDistribucion((cfg.billeterasDistribucion && typeof cfg.billeterasDistribucion === 'object') ? cfg.billeterasDistribucion : {});
            // Subcategorías de gastos: usar las guardadas o completar con las predeterminadas
            const subcatsGastoGuardadas = (cfg.subcategoriasGasto && typeof cfg.subcategoriasGasto === 'object') ? cfg.subcategoriasGasto : {};
            const subcatsGasto = {};
            catsGasto.forEach(cat => {
              subcatsGasto[cat] = Array.isArray(subcatsGastoGuardadas[cat])
                ? subcatsGastoGuardadas[cat]
                : (SUBCATEGORIAS_GASTO_PREDETERMINADAS[cat] || []);
            });
            setSubcategoriasGasto(subcatsGasto);
            // Subcategorías de ingresos
            const subcatsIngresoGuardadas = (cfg.subcategoriasIngreso && typeof cfg.subcategoriasIngreso === 'object') ? cfg.subcategoriasIngreso : {};
            const subcatsIngreso = {};
            catsIngreso.forEach(cat => {
              subcatsIngreso[cat] = Array.isArray(subcatsIngresoGuardadas[cat])
                ? subcatsIngresoGuardadas[cat]
                : (SUBCATEGORIAS_INGRESO_PREDETERMINADAS[cat] || []);
            });
            setSubcategoriasIngreso(subcatsIngreso);
            if (cfg.combustible) {
              setPrecioNafta(cfg.combustible.nafta != null ? String(cfg.combustible.nafta) : '');
              setPrecioGnc(cfg.combustible.gnc != null ? String(cfg.combustible.gnc) : '');
            }
          } else {
            setCategoriasGasto(CATEGORIAS_GASTO_PREDETERMINADAS);
            setSubcategoriasGasto(SUBCATEGORIAS_GASTO_PREDETERMINADAS);
            setCategoriasIngreso(CATEGORIAS_INGRESO_PREDETERMINADAS);
            setSubcategoriasIngreso(SUBCATEGORIAS_INGRESO_PREDETERMINADAS);
            setBilleterasFinanzas(BILLETERAS_PREDETERMINADAS);
            setBilleterasReserva([]);
            setBilleterasDistribucion({});
          }
        } catch (e) {
          console.error("Error al cargar config finanzas:", e);
        }

        const resClima = await fetch('https://api.open-meteo.com/v1/forecast?latitude=-38.7196&longitude=-62.2724&daily=temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,weathercode&hourly=temperature_2m,precipitation_probability,precipitation&timezone=America/Argentina/Buenos_Aires&forecast_days=16&past_days=7');
        const dataClima = await resClima.json();
        
        if (dataClima && dataClima.daily) {
          let mapaClima = {};
          dataClima.daily.time.forEach((fechaStr, index) => {
            const diaNum = parseInt(fechaStr.split('-')[2]);
            mapaClima[diaNum] = {
              tempMax: dataClima.daily.temperature_2m_max[index],
              tempMin: dataClima.daily.temperature_2m_min[index],
              lluvia: dataClima.daily.precipitation_sum[index],
              probLluvia: dataClima.daily.precipitation_probability_max[index] || 0,
              codigo: dataClima.daily.weathercode[index]
            };
          });
          setClimaPronostico(mapaClima);
        }

        if (dataClima && dataClima.hourly && dataClima.hourly.time) {
          let mapaPorHora = {};
          dataClima.hourly.time.forEach((fechaHoraStr, index) => {
            const [fechaStr, horaStr] = fechaHoraStr.split('T');
            const diaNum = parseInt(fechaStr.split('-')[2]);
            if (!mapaPorHora[diaNum]) mapaPorHora[diaNum] = [];
            mapaPorHora[diaNum].push({
              hora: horaStr,
              temp: dataClima.hourly.temperature_2m[index],
              probLluvia: dataClima.hourly.precipitation_probability[index] || 0,
              lluvia: dataClima.hourly.precipitation[index] || 0
            });
          });
          setClimaPorHora(mapaPorHora);
        }

      } catch (error) {
        console.error("Error al cargar datos:", error);
      } finally {
        setCargando(false);
      }
    };
    cargarDatosYClima();
  }, [fecha.idMes, fecha.totalDias]);

  const acumuladoReal = dias.reduce((acc, d) => acc + (d.real || 0), 0);
  const metaRestante = metaTotal - acumuladoReal;
  const objetivoHoy = dias.find(d => d.dia === diaSeleccionado)?.esperado || 0;
  const yaCargadoHoy = dias && dias.length > 0 && dias.find(d => d?.dia === diaSeleccionado)?.real !== null;
  const puedeFranco = dias && dias.length > 0 ? calcularSiPuedeFranco(dias) : false;
  const diaFrancoAsignado = dias && dias.length > 0 ? obtenerDiaFrancoAsignado(dias) : null;
  const excedenteAcumulado = dias && dias.length > 0 ? calcularExcedenteAcumulado(dias) : 0;
  const proximoDiaPendiente = dias && dias.length > 0 ? obtenerProximoDiaPendiente(dias) : null;

  const mantenimientosPeriodicos = registrosVehiculo
    .filter(r => r.tipo === 'mantenimiento' && r.periodico && r.cadaKm && !r.hecho);

  const resumenVehiculo = mantenimientosPeriodicos.length === 0
    ? 'Sin mantenimiento periódico'
    : (!kmAuto || kmAuto <= 0)
      ? 'Registrá km para calcular'
      : (() => {
          let elegido = null;
          let minFaltante = Infinity;
          mantenimientosPeriodicos.forEach(r => {
            const faltante = (r.km + r.cadaKm) - kmAuto;
            if (faltante < minFaltante) {
              minFaltante = faltante;
              elegido = r;
            }
          });
          const tipo = elegido?.tipoMantenimiento || 'mantenimiento';
          return minFaltante > 0
            ? `Próximo: ${tipo} en ${formatearKm(minFaltante)}`
            : `Vencido: ${tipo}`;
        })();

  const datosGraficoKm = (() => {
    const ordenados = registrosVehiculo
      .filter(r => r.km)
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    const porFecha = new Map();
    ordenados.forEach(r => {
      const fecha = (r.fecha || '').slice(0, 10);
      const km = Number(r.km) || 0;
      const actual = porFecha.get(fecha);
      if (!actual || km > actual) porFecha.set(fecha, km);
    });
    const fechas = [...porFecha.keys()].sort();
    return fechas
      .slice(1)
      .map((fecha, i) => {
        const km = porFecha.get(fecha);
        const kmAnterior = porFecha.get(fechas[i]);
        const recorrido = km >= kmAnterior ? km - kmAnterior : km;
        return { fecha, km: recorrido };
      });
  })();

  const climaHoy = climaPronostico[fecha.diaHoy];
  const esDiaDeAltaDemanda = climaHoy && ((climaHoy.probLluvia > 50 && climaHoy.lluvia > 1) || climaHoy.tempMax < 12);

  const diaHoyObj = dias[diaSeleccionado - 1] || {};
  const estadoJornadaHoy = diaHoyObj.estadoJornada || null;
  const acumuladoHoy = acumuladoJornada(diaHoyObj);
  const horasHoyCalculadas = calcularHorasJornada(diaHoyObj);

  const guardarEnFirebase = async (meta, nuevosDias) => {
    try {
      await setDoc(doc(db, 'planificador', fecha.idMes), {
        metaTotal: meta,
        dias: nuevosDias
      });
    } catch (error) {
      console.error("Error al guardar:", error);
    }
  };

  const aplicarDias = (nuevosDias) => {
    setDias(nuevosDias);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  // ===== Sección Vehículo: guardado de registros =====
  const guardarRegistroVehiculo = async (registro) => {
    const nuevos = [...registrosVehiculo, registro];
    const nuevoKmAuto = Math.max(kmAuto, Number(registro.km) || 0);
    setRegistrosVehiculo(nuevos);
    setKmAuto(nuevoKmAuto);
    try {
      await setDoc(doc(db, 'vehiculo', 'registros'), { registros: nuevos, kmAuto: nuevoKmAuto });
    } catch (error) {
      console.error("Error al guardar registro de vehículo:", error);
    }
  };

  const abrirCombustible = () => {
    const hoy = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const fechaHora = `${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(hoy.getDate())}T${pad(hoy.getHours())}:${pad(hoy.getMinutes())}`;
    const ultKm = obtenerUltimoKmGlobal(dias, dias.length + 1);
    setCombFecha(fechaHora);
    setCombValor('');
    setCombKm(ultKm != null ? String(ultKm) : '');
    setCombGnc(true);
    setCombNafta(false);
    setShowCombustibleModal(true);
  };

  const guardarCombustible = async () => {
    const valor = parseFloat(combValor);
    const km = parseFloat(combKm);
    if (!combFecha) return alert('Seleccioná una fecha.');
    if (isNaN(valor) || valor <= 0) return alert('Ingresá un valor válido ($).');
    if (isNaN(km) || km <= 0) return alert('Ingresá los kilómetros del odómetro.');
    const registro = {
      tipo: 'combustible',
      fecha: combFecha,
      valor,
      km,
      combustible: combGnc ? 'gnc' : 'nafta',
      ts: Date.now()
    };
    await guardarRegistroVehiculo(registro);
    abrirGastoDesdeCombustible(valor, combGnc, combFecha.slice(0, 10));
    setShowCombustibleModal(false);
  };

  const abrirReparacion = () => {
    const hoy = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ultKm = obtenerUltimoKmGlobal(dias, dias.length + 1);
    setRepFecha(`${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(hoy.getDate())}`);
    setRepValor('');
    setRepKm(ultKm != null ? String(ultKm) : '');
    setRepTipo('');
    setShowReparacionModal(true);
  };

  const guardarReparacion = () => {
    const valor = parseFloat(repValor);
    const km = parseFloat(repKm);
    if (!repFecha) return alert('Seleccioná una fecha.');
    if (isNaN(valor) || valor <= 0) return alert('Ingresá un valor válido ($).');
    if (isNaN(km) || km <= 0) return alert('Ingresá los kilómetros del odómetro.');
    if (!repTipo.trim()) return alert('Ingresá el tipo de reparación.');
    const registro = {
      tipo: 'reparacion',
      fecha: repFecha,
      valor,
      km,
      tipoReparacion: repTipo.trim(),
      ts: Date.now()
    };
    guardarRegistroVehiculo(registro);
    setShowReparacionModal(false);
  };

  const abrirMantenimiento = () => {
    const hoy = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ultKm = obtenerUltimoKmGlobal(dias, dias.length + 1);
    setMantFecha(`${hoy.getFullYear()}-${pad(hoy.getMonth() + 1)}-${pad(hoy.getDate())}`);
    setMantValor('');
    setMantKm(ultKm != null ? String(ultKm) : '');
    setMantTipo('');
    setMantPeriodico(false);
    setMantCadaKm('');
    setShowMantenimientoModal(true);
  };

  const guardarMantenimiento = () => {
    const valor = parseFloat(mantValor);
    const km = parseFloat(mantKm);
    if (!mantFecha) return alert('Seleccioná una fecha.');
    if (isNaN(valor) || valor <= 0) return alert('Ingresá un valor válido ($).');
    if (isNaN(km) || km <= 0) return alert('Ingresá los kilómetros del odómetro.');
    if (!mantTipo.trim()) return alert('Ingresá el tipo de mantenimiento.');
    if (mantPeriodico && (isNaN(parseFloat(mantCadaKm)) || parseFloat(mantCadaKm) <= 0)) {
      return alert('Ingresá cada cuántos kilómetros se realiza el mantenimiento.');
    }
    const registro = {
      tipo: 'mantenimiento',
      fecha: mantFecha,
      valor,
      km,
      tipoMantenimiento: mantTipo.trim(),
      periodico: mantPeriodico,
      cadaKm: mantPeriodico ? parseFloat(mantCadaKm) : null,
      ts: Date.now()
    };
    guardarRegistroVehiculo(registro);
    setShowMantenimientoModal(false);
  };

  const toggleHechoMantenimiento = async (ts) => {
    const registro = registrosVehiculo.find(r => r.ts === ts);
    if (!registro || !registro.periodico || !registro.cadaKm) {
      const simples = registrosVehiculo.map(r => r.ts === ts ? { ...r, hecho: !r.hecho } : r);
      setRegistrosVehiculo(simples);
      try {
        await setDoc(doc(db, 'vehiculo', 'registros'), { registros: simples, kmAuto });
      } catch (error) {
        console.error("Error al actualizar mantenimiento:", error);
      }
      return;
    }
    let nuevos;
    if (!registro.hecho) {
      const kmBase = Number(registro.km) || 0;
      const nuevoRegistro = {
        tipo: 'mantenimiento',
        fecha: new Date().toISOString().slice(0, 10),
        valor: 0,
        km: kmBase,
        tipoMantenimiento: registro.tipoMantenimiento,
        periodico: true,
        cadaKm: registro.cadaKm,
        auto: true,
        ts: Date.now()
      };
      nuevos = registrosVehiculo
        .filter(r => r.ts === ts || !(r.tipo === 'mantenimiento' && r.periodico && r.cadaKm && !r.hecho &&
          r.tipoMantenimiento === registro.tipoMantenimiento && r.cadaKm === registro.cadaKm))
        .map(r => r.ts === ts ? { ...r, hecho: true } : r)
        .concat(nuevoRegistro);
    } else {
      nuevos = registrosVehiculo
        .map(r => r.ts === ts ? { ...r, hecho: false } : r)
        .filter(r => !(r.auto && !r.hecho &&
          r.tipoMantenimiento === registro.tipoMantenimiento &&
          r.cadaKm === registro.cadaKm));
    }
    setRegistrosVehiculo(nuevos);
    try {
      await setDoc(doc(db, 'vehiculo', 'registros'), { registros: nuevos, kmAuto });
    } catch (error) {
      console.error("Error al actualizar mantenimiento:", error);
    }
  };

  const validarKmContraUltimo = (kmFloat, ultKm) => {
    if (ultKm !== null && kmFloat < ultKm) {
      alert(`El kilometraje no puede ser menor al último registrado (${formatearKm(ultKm)}).`);
      return false;
    }
    return true;
  };

  // ===== Sección Finanzas: guardado =====
  const guardarConfigFinanzas = async (catsGasto, biels, subcatsGasto, reserva, distribucion, catsIngreso, subcatsIngreso) => {
    try {
      await setDoc(doc(db, 'finanzas', 'config'), {
        categoriasGasto: catsGasto !== undefined ? catsGasto : categoriasGasto,
        categoriasIngreso: catsIngreso !== undefined ? catsIngreso : categoriasIngreso,
        billeteras: biels,
        subcategoriasGasto: subcatsGasto !== undefined ? subcatsGasto : subcategoriasGasto,
        subcategoriasIngreso: subcatsIngreso !== undefined ? subcatsIngreso : subcategoriasIngreso,
        billeterasReserva: reserva !== undefined ? reserva : billeterasReserva,
        billeterasDistribucion: distribucion !== undefined ? distribucion : billeterasDistribucion,
        combustible: {
          nafta: parseFloat(precioNafta) || 0,
          gnc: parseFloat(precioGnc) || 0
        }
      });
    } catch (error) {
      console.error("Error al guardar config finanzas:", error);
    }
  };

  const guardarCombustibleConfig = () => {
    const nafta = parseFloat(precioNafta);
    const gnc = parseFloat(precioGnc);
    if (!isNaN(nafta) && nafta <= 0 && !isNaN(gnc) && gnc <= 0) return alert('Ingresá al menos un valor de combustible.');
    setDoc(doc(db, 'finanzas', 'config'), {
      categoriasGasto: categoriasGasto,
      categoriasIngreso: categoriasIngreso,
      billeteras: billeterasFinanzas,
      subcategoriasGasto: subcategoriasGasto,
      subcategoriasIngreso: subcategoriasIngreso,
      billeterasReserva: billeterasReserva,
      billeterasDistribucion: billeterasDistribucion,
      combustible: {
        nafta: isNaN(nafta) ? 0 : nafta,
        gnc: isNaN(gnc) ? 0 : gnc
      }
    }).catch(() => alert('Error al guardar los precios de combustible.'));
  };

  const guardarMovimientosFinanzas = async (nuevos) => {
    try {
      await setDoc(doc(db, 'finanzas', 'movimientos'), { movimientos: nuevos });
      return true;
    } catch (error) {
      console.error("Error al guardar finanzas:", error);
      return false;
    }
  };

  const abrirGasto = (mov) => {
    if (mov) {
      setGastoMonto(mov.monto != null ? String(mov.monto) : '');
      setGastoDescripcion(mov.descripcion || '');
      setGastoSeRepite(!!mov.seRepite);
      setGastoCuota(String(mov.cuotaActual || 1));
      setGastoTotalCuotas(mov.totalCuotas ? String(mov.totalCuotas) : '');
      setGastoFrecuencia(mov.frecuencia || 'mensual');
      setGastoMontoEs(mov.montoEs || 'cuota');
      setGastoFecha(mov.fecha || hoyComoStr());
      setGastoRealizada(mov.realizada !== false);
      setGastoCategoria(mov.categoria || '');
      setGastoSubcategoria(mov.subcategoria || '');
      setGastoBilletera(mov.billetera || '');
      setMovEnEdicion(mov);
    } else {
      setGastoMonto('');
      setGastoDescripcion('');
      setGastoSeRepite(false);
      setGastoCuota('1');
      setGastoTotalCuotas('');
      setGastoFrecuencia('mensual');
      setGastoMontoEs('cuota');
      setGastoFecha(hoyComoStr());
      setGastoRealizada(true);
      setGastoCategoria('');
      setGastoSubcategoria('');
      setGastoBilletera('');
      setMovEnEdicion(null);
    }
    setCalcAbierta(false);
    setShowGastoModal(true);
  };

  const abrirGastoDesdeCombustible = (valor, gnc, fechaCarga) => {
    setGastoMonto(String(valor));
    setGastoDescripcion(`Carga de combustible (${gnc ? 'GNC' : 'Nafta'})`);
    setGastoSeRepite(false);
    setGastoCuota('1');
    setGastoTotalCuotas('');
    setGastoFrecuencia('mensual');
    setGastoMontoEs('cuota');
    setGastoFecha(fechaCarga);
    setGastoRealizada(true);
    setGastoCategoria('Auto');
    setGastoSubcategoria('Combustible');
    setGastoBilletera('YPF');
    setMovEnEdicion(null);
    setCalcAbierta(false);
    setShowGastoModal(true);
  };

  const guardarGasto = async () => {
    const monto = parseFloat(gastoMonto);
    if (isNaN(monto) || monto <= 0) return alert('Ingresá un monto válido ($).');
    if (!gastoCategoria.trim()) return alert('Elegí o agregá una categoría.');
    if (!gastoBilletera.trim()) return alert('Elegí o agregá la billetera.');
    if (!gastoFecha) return alert('Seleccioná una fecha.');

    const seRepite = gastoSeRepite;
    let totalCuotas = null;
    let cuotaActual = null;
    let montoEs = null;
    let frecuencia = null;
    let montoTotal = monto;
    let montoCuota = monto;
    if (seRepite) {
      frecuencia = gastoFrecuencia;
      if (frecuencia === 'fijo') {
        montoEs = 'fijo';
      } else {
        totalCuotas = parseInt(gastoTotalCuotas, 10);
        if (!totalCuotas || totalCuotas < 1) return alert('Ingresá la cantidad total de cuotas.');
        cuotaActual = Math.max(1, parseInt(gastoCuota, 10) || 1);
        montoEs = gastoMontoEs;
        if (gastoMontoEs === 'total') {
          montoTotal = monto;
          montoCuota = monto / totalCuotas;
        } else {
          montoCuota = monto;
          montoTotal = monto * totalCuotas;
        }
      }
    }

    const editando = !!movEnEdicion;
    const movimiento = {
      tipo: 'gasto',
      descripcion: gastoDescripcion.trim(),
      monto: seRepite ? montoCuota : monto,
      montoTotal,
      montoCuota,
      montoEs,
      categoria: gastoCategoria.trim(),
      subcategoria: gastoSubcategoria.trim(),
      billetera: gastoBilletera.trim(),
      fecha: gastoFecha,
      ts: editando ? movEnEdicion.ts : Date.now(),
      seRepite,
      esCuotas: seRepite,
      totalCuotas,
      cuotaActual,
      frecuencia,
      realizada: !!gastoRealizada,
      ...(movEnEdicion && movEnEdicion.cuotasOmitidas ? { cuotasOmitidas: movEnEdicion.cuotasOmitidas } : {})
    };
    const nuevos = editando
      ? movimientosFinanzas.map(m => m.ts === movEnEdicion.ts ? movimiento : m)
      : [...movimientosFinanzas, movimiento];
    const ok = await guardarMovimientosFinanzas(nuevos);
    if (!ok) {
      alert('No se pudo guardar el gasto. Revisá tu conexión o los permisos de Firestore.');
      return;
    }
    setMovimientosFinanzas(nuevos);
    setShowGastoModal(false);
    setMovEnEdicion(null);
  };

  const abrirIngreso = (mov) => {
    if (mov) {
      setIngresoMonto(mov.monto != null ? String(mov.monto) : '');
      setIngresoDescripcion(mov.descripcion || '');
      setIngresoSeRepite(!!mov.seRepite);
      setIngresoCuota(String(mov.cuotaActual || 1));
      setIngresoTotalCuotas(mov.totalCuotas ? String(mov.totalCuotas) : '');
      setIngresoFrecuencia(mov.frecuencia || 'mensual');
      setIngresoMontoEs(mov.montoEs || 'cuota');
      setIngresoFecha(mov.fecha || hoyComoStr());
      setIngresoRealizada(mov.realizada !== false);
      setIngresoCategoria(mov.categoria || '');
      setIngresoSubcategoria(mov.subcategoria || '');
      setIngresoBilletera(mov.billetera || '');
      setIngresoDistribuir(false);
      setIngresoDistribucion([]);
      setMovEnEdicion(mov);
    } else {
      setIngresoMonto('');
      setIngresoDescripcion('');
      setIngresoSeRepite(false);
      setIngresoCuota('1');
      setIngresoTotalCuotas('');
      setIngresoFrecuencia('mensual');
      setIngresoMontoEs('cuota');
      setIngresoFecha(hoyComoStr());
      setIngresoRealizada(true);
      setIngresoCategoria('');
      setIngresoSubcategoria('');
      setIngresoBilletera('');
      setIngresoDistribuir(false);
      setIngresoDistribucion([]);
      setMovEnEdicion(null);
    }
    setCalcAbierta(false);
    setShowIngresoModal(true);
  };

  const guardarIngreso = async () => {
    const monto = parseFloat(ingresoMonto);
    if (isNaN(monto) || monto <= 0) return alert('Ingresá un monto válido ($).');
    if (!ingresoCategoria.trim()) return alert('Elegí o agregá una categoría.');
    if (!ingresoFecha) return alert('Seleccioná una fecha.');

    let filas;
    if (ingresoDistribuir) {
      filas = ingresoDistribucion
        .map(f => ({ billetera: (f.billetera || '').trim(), pct: parseFloat(f.porcentaje) }))
        .filter(f => f.billetera && !isNaN(f.pct) && f.pct > 0);
      if (filas.length === 0) return alert('Agregá al menos una billetera con su porcentaje.');
      const sumaPorcentajes = filas.reduce((acc, f) => acc + f.pct, 0);
      if (Math.abs(sumaPorcentajes - 100) >= 0.05) {
        return alert(`Los porcentajes deben sumar 100% (dan ${sumaPorcentajes.toLocaleString('es-AR', { maximumFractionDigits: 2 })}%).`);
      }
    } else {
      if (!ingresoBilletera.trim()) return alert('Elegí o agregá la billetera.');
      filas = [{ billetera: ingresoBilletera.trim(), pct: 100 }];
    }

    const seRepite = ingresoSeRepite;
    const frecuencia = seRepite ? ingresoFrecuencia : null;
    const montoEs = seRepite ? (ingresoFrecuencia === 'fijo' ? 'fijo' : ingresoMontoEs) : null;
    let totalCuotas = null;
    let cuotaActual = null;
    if (seRepite && ingresoFrecuencia !== 'fijo') {
      totalCuotas = parseInt(ingresoTotalCuotas, 10);
      if (!totalCuotas || totalCuotas < 1) return alert('Ingresá la cantidad total de cuotas.');
      cuotaActual = Math.max(1, parseInt(ingresoCuota, 10) || 1);
    }

    const editando = !!movEnEdicion;
    const baseTs = editando && movEnEdicion.grupo ? movEnEdicion.grupo : editando ? movEnEdicion.ts : Date.now();
    const distribuido = editando && !!movEnEdicion.grupo;
    const distribucionRef = filas.map(f => ({ billetera: f.billetera, porcentaje: f.pct }));
    const omitidas = movEnEdicion && movEnEdicion.cuotasOmitidas ? movEnEdicion.cuotasOmitidas : undefined;
    const nuevosMovs = [];
    filas.forEach((fila, idx) => {
      const share = monto * (fila.pct / 100);
      let montoTotal = share;
      let montoCuota = share;
      if (seRepite && ingresoFrecuencia !== 'fijo') {
        if (ingresoMontoEs === 'total') {
          montoTotal = share;
          montoCuota = share / totalCuotas;
        } else {
          montoCuota = share;
          montoTotal = share * totalCuotas;
        }
      }
      const mov = {
        tipo: 'ingreso',
        descripcion: ingresoDescripcion.trim(),
        monto: seRepite ? montoCuota : share,
        montoTotal,
        montoCuota,
        montoEs,
        categoria: ingresoCategoria.trim(),
        subcategoria: ingresoSubcategoria.trim(),
        billetera: fila.billetera,
        porcentaje: fila.pct,
        distribucion: distribucionRef,
        grupo: baseTs,
        fecha: ingresoFecha,
        ts: baseTs + idx,
        seRepite,
        esCuotas: seRepite,
        totalCuotas,
        cuotaActual,
        frecuencia,
        realizada: !!ingresoRealizada
      };
      if (omitidas && !distribuido) mov.cuotasOmitidas = omitidas;
      nuevosMovs.push(mov);
    });
    let nuevos;
    if (editando && distribuido && !ingresoDistribuir) {
      // Editar un ingreso distribuido sin modo distribución: actualiza solo el
      // movimiento tocado, conservando su grupo/porcentaje/distribución original.
      const original = movEnEdicion;
      const share = monto * ((original.porcentaje || 100) / 100);
      let mmontoTotal = share;
      let mmontoCuota = share;
      if (seRepite && ingresoFrecuencia !== 'fijo') {
        if (ingresoMontoEs === 'total') { mmontoTotal = share; mmontoCuota = share / totalCuotas; }
        else { mmontoCuota = share; mmontoTotal = share * totalCuotas; }
      }
      const actualizado = {
        ...original,
        descripcion: ingresoDescripcion.trim(),
        monto: seRepite ? mmontoCuota : share,
        montoTotal: mmontoTotal,
        montoCuota: mmontoCuota,
        montoEs,
        categoria: ingresoCategoria.trim(),
        subcategoria: ingresoSubcategoria.trim(),
        fecha: ingresoFecha,
        seRepite,
        esCuotas: seRepite,
        totalCuotas,
        cuotaActual,
        frecuencia,
        realizada: !!ingresoRealizada
      };
      nuevos = movimientosFinanzas.map(x => x.ts === original.ts ? actualizado : x);
    } else if (editando && distribuido) {
      const grupo = movEnEdicion.grupo;
      const sinGrupo = movimientosFinanzas.filter(m => m.grupo !== grupo);
      nuevos = [...sinGrupo, ...nuevosMovs];
    } else if (editando) {
      const ts = movEnEdicion.ts;
      nuevos = movimientosFinanzas.map(m => m.ts === ts ? nuevosMovs[0] : m);
    } else {
      nuevos = [...movimientosFinanzas, ...nuevosMovs];
    }
    const ok = await guardarMovimientosFinanzas(nuevos);
    if (!ok) {
      alert('No se pudo guardar el ingreso. Revisá tu conexión o los permisos de Firestore.');
      return;
    }
    setMovimientosFinanzas(nuevos);
    setShowIngresoModal(false);
    setMovEnEdicion(null);
  };

  const abrirEdicionMovimiento = (m) => {
    if (!m) return;
    if (m.tipo === 'transfer') return; // las transferencias no se editan desde el modal de gasto/ingreso
    if (m.tipo === 'gasto') abrirGasto(m);
    else abrirIngreso(m);
  };

  const agregarFilaIngreso = () => {
    setIngresoDistribucion(d => [...d, { billetera: '', porcentaje: '' }]);
  };
  const actualizarFilaIngreso = (idx, campo, valor) => {
    setIngresoDistribucion(d => d.map((f, i) => i === idx ? { ...f, [campo]: valor } : f));
  };
  const quitarFilaIngreso = (idx) => {
    setIngresoDistribucion(d => d.filter((_, i) => i !== idx));
  };
  const prepararDistribucionIngreso = () => {
    const configuradas = Object.entries(billeterasDistribucion)
      .filter(([b, p]) => b && parseFloat(p) > 0)
      .map(([b, p]) => ({ billetera: b, porcentaje: String(p) }));
    setIngresoDistribucion(configuradas.length ? configuradas : [{ billetera: '', porcentaje: '' }]);
  };

  const abrirConfirmarBorrado = (m, mesId) => {
    setMovConfirmarBorrar(m);
    setMovConfirmarBorrarMes(mesId || null);
  };
  const cerrarConfirmarBorrado = () => {
    setMovConfirmarBorrar(null);
    setMovConfirmarBorrarMes(null);
  };

  const confirmarBorradoSerie = () => {
    const m = movConfirmarBorrar;
    if (!m) return;
    let nuevos;
    if (m.grupo) {
      nuevos = movimientosFinanzas.filter(x => x.grupo !== m.grupo);
    } else {
      nuevos = movimientosFinanzas.filter(x => x.ts !== m.ts);
    }
    setMovimientosFinanzas(nuevos);
    guardarMovimientosFinanzas(nuevos);
    cerrarConfirmarBorrado();
  };

  const confirmarBorradoCuota = () => {
    const m = movConfirmarBorrar;
    const mesId = movConfirmarBorrarMes;
    if (!m || !mesId) return;
    const omitidas = Array.isArray(m.cuotasOmitidas) ? [...m.cuotasOmitidas] : [];
    if (!omitidas.includes(mesId)) omitidas.push(mesId);
    const nuevos = movimientosFinanzas.map(x => {
      if (m.grupo && x.grupo === m.grupo) return { ...x, cuotasOmitidas: omitidas };
      if (!m.grupo && x.ts === m.ts) return { ...x, cuotasOmitidas: omitidas };
      return x;
    });
    setMovimientosFinanzas(nuevos);
    guardarMovimientosFinanzas(nuevos);
    cerrarConfirmarBorrado();
  };

  const alternarRealizada = (ts) => {
    const nuevos = movimientosFinanzas.map(m =>
      m.ts === ts ? { ...m, realizada: !m.realizada } : m
    );
    setMovimientosFinanzas(nuevos);
    guardarMovimientosFinanzas(nuevos);
  };

  const abrirCalculadora = (destino) => {
    setCalcDestino(destino);
    setCalcSeq(s => s + 1);
    setCalcAbierta(true);
  };

  const usarCalculadora = (valor) => {
    const str = String(Number(valor));
    if (calcDestino === 'gasto') setGastoMonto(str);
    else setIngresoMonto(str);
    setCalcAbierta(false);
  };

  const eliminarCategoriaGasto = (cat) => {
    const nuevasCats = categoriasGasto.filter(c => c !== cat);
    setCategoriasGasto(nuevasCats);
    const nuevasSubs = { ...subcategoriasGasto };
    delete nuevasSubs[cat];
    setSubcategoriasGasto(nuevasSubs);
    guardarConfigFinanzas(nuevasCats, billeterasFinanzas, nuevasSubs);
  };

  const eliminarCategoriaIngreso = (cat) => {
    const nuevasCats = categoriasIngreso.filter(c => c !== cat);
    setCategoriasIngreso(nuevasCats);
    const nuevasSubs = { ...subcategoriasIngreso };
    delete nuevasSubs[cat];
    setSubcategoriasIngreso(nuevasSubs);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, undefined, undefined, nuevasCats, nuevasSubs);
  };

  const eliminarBilleteraFinanzas = (biel) => {
    const nuevasBiels = billeterasFinanzas.filter(b => b !== biel);
    const nuevasReserva = billeterasReserva.filter(r => r !== biel);
    if (nuevasReserva.length !== billeterasReserva.length) setBilleterasReserva(nuevasReserva);
    const nuevasDistribucion = { ...billeterasDistribucion };
    if (biel in nuevasDistribucion) {
      delete nuevasDistribucion[biel];
      setBilleterasDistribucion(nuevasDistribucion);
    }
    setBilleterasFinanzas(nuevasBiels);
    guardarConfigFinanzas(categoriasGasto, nuevasBiels, subcategoriasGasto, nuevasReserva, nuevasDistribucion, categoriasIngreso, subcategoriasIngreso);
  };

  const alternarReservaBilletera = (biel) => {
    const yaEsReserva = billeterasReserva.includes(biel);
    const nuevasReserva = yaEsReserva
      ? billeterasReserva.filter(r => r !== biel)
      : [...billeterasReserva, biel];
    setBilleterasReserva(nuevasReserva);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, nuevasReserva, undefined, categoriasIngreso, subcategoriasIngreso);
  };

  const setDistribucionActiva = (biel, activa) => {
    const nuevas = { ...billeterasDistribucion };
    if (activa) {
      if (!(biel in nuevas)) nuevas[biel] = '';
    } else {
      delete nuevas[biel];
    }
    setBilleterasDistribucion(nuevas);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, billeterasReserva, nuevas, categoriasIngreso, subcategoriasIngreso);
  };
  const actualizarPorcentajeDistribucion = (biel, pct) => {
    const nuevas = { ...billeterasDistribucion };
    const num = parseFloat(pct);
    nuevas[biel] = (pct === '' || isNaN(num) || num <= 0) ? '' : num;
    setBilleterasDistribucion(nuevas);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, billeterasReserva, nuevas, categoriasIngreso, subcategoriasIngreso);
  };

  const abrirAjusteSaldo = () => {
    setAjusteSaldoValor('');
    setAjusteSaldoAbierto(true);
  };

  const cerrarAjusteSaldo = () => setAjusteSaldoAbierto(false);

  const abrirTransferencia = () => {
    setTransferenciaOrigen(billeteraSeleccionada);
    setTransferenciaDestino('');
    setTransferenciaMonto('');
    setTransferenciaAbierta(true);
  };

  const cerrarTransferencia = () => setTransferenciaAbierta(false);

  const confirmarTransferencia = () => {
    const monto = parseFloat(transferenciaMonto);
    if (isNaN(monto) || monto <= 0) return alert('Ingresá un monto válido.');
    const origen = (transferenciaOrigen || '').trim();
    const destino = (transferenciaDestino || '').trim();
    if (!origen) return alert('Elegí la billetera de origen.');
    if (!destino) return alert('Elegí la billetera de destino.');
    if (origen === destino) return alert('El origen y el destino deben ser billeteras distintas.');
    const saldoOrigen = saldoBilletera(origen, movimientosFinanzas, fecha.idMes);
    if (monto > saldoOrigen + 0.01) {
      return alert(`No hay saldo suficiente en ${origen}. Saldo actual: ${formatearDinero(saldoOrigen)}`);
    }
    setTransferenciaAbierta(false);
    const movimiento = {
      tipo: 'transfer',
      descripcion: `Transferencia de ${origen} a ${destino}`,
      monto,
      billetera: origen,
      billeteraDestino: destino,
      fecha: hoyComoStr(),
      ts: Date.now(),
      realizada: true
    };
    const nuevos = [...movimientosFinanzas, movimiento];
    setMovimientosFinanzas(nuevos);
    guardarMovimientosFinanzas(nuevos);
  };

  const confirmarAjusteSaldo = () => {
    const nuevo = parseFloat(ajusteSaldoValor);
    if (isNaN(nuevo) || nuevo < 0) return alert('Ingresá un monto válido.');
    const actual = saldoBilletera(billeteraSeleccionada, movimientosFinanzas, fecha.idMes);
    const diff = nuevo - actual;
    if (Math.abs(diff) < 0.01) {
      return alert('El monto ingresado es igual al saldo actual. No hay diferencia para ajustar.');
    }
    setAjusteSaldoAbierto(false);
    if (diff > 0) {
      setIngresoMonto(diff.toFixed(2));
      setIngresoDescripcion('Ajuste de saldo');
      setIngresoSeRepite(false);
      setIngresoCuota('1');
      setIngresoTotalCuotas('');
      setIngresoFrecuencia('mensual');
      setIngresoMontoEs('cuota');
      setIngresoFecha(hoyComoStr());
      setIngresoRealizada(true);
      setIngresoCategoria('');
      setIngresoSubcategoria('');
      setIngresoBilletera(billeteraSeleccionada);
      setIngresoDistribuir(false);
      setIngresoDistribucion([]);
      setCalcAbierta(false);
      setShowIngresoModal(true);
    } else {
      setGastoMonto(Math.abs(diff).toFixed(2));
      setGastoDescripcion('Ajuste de saldo');
      setGastoSeRepite(false);
      setGastoCuota('1');
      setGastoTotalCuotas('');
      setGastoFrecuencia('mensual');
      setGastoMontoEs('cuota');
      setGastoFecha(hoyComoStr());
      setGastoRealizada(true);
      setGastoCategoria('');
      setGastoSubcategoria('');
      setGastoBilletera(billeteraSeleccionada);
      setCalcAbierta(false);
      setShowGastoModal(true);
    }
  };

  const agregarCategoriaConfig = (tipo) => {
    if (!nuevaCategoria.trim()) return;
    if (tipo === 'ingreso') {
      if (!categoriasIngreso.some(c => c.toLowerCase() === nuevaCategoria.trim().toLowerCase())) {
        const nuevasCats = [...categoriasIngreso, nuevaCategoria.trim()];
        const nuevasSubs = { ...subcategoriasIngreso, [nuevaCategoria.trim()]: [] };
        setCategoriasIngreso(nuevasCats);
        setSubcategoriasIngreso(nuevasSubs);
        guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, undefined, undefined, nuevasCats, nuevasSubs);
      }
      setNuevaCategoria('');
      return;
    }
    if (!categoriasGasto.some(c => c.toLowerCase() === nuevaCategoria.trim().toLowerCase())) {
      const nuevasCats = [...categoriasGasto, nuevaCategoria.trim()];
      const nuevasSubs = { ...subcategoriasGasto, [nuevaCategoria.trim()]: [] };
      setCategoriasGasto(nuevasCats);
      setSubcategoriasGasto(nuevasSubs);
      guardarConfigFinanzas(nuevasCats, billeterasFinanzas, nuevasSubs);
    }
    setNuevaCategoria('');
  };

  const agregarSubcategoriaConfig = (tipo, cat) => {
    if (!nuevaSubcategoria.trim()) return;
    if (tipo === 'ingreso') return agregarSubcategoriaIngresoConfig(cat);
    const actuales = subcategoriasGasto[cat] || [];
    if (actuales.some(s => s.toLowerCase() === nuevaSubcategoria.trim().toLowerCase())) {
      setNuevaSubcategoria('');
      return;
    }
    const nuevasSubs = { ...subcategoriasGasto, [cat]: [...actuales, nuevaSubcategoria.trim()] };
    setSubcategoriasGasto(nuevasSubs);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, nuevasSubs);
    setNuevaSubcategoria('');
  };

  const agregarSubcategoriaIngresoConfig = (cat) => {
    if (!nuevaSubcategoria.trim()) return;
    const actuales = subcategoriasIngreso[cat] || [];
    if (actuales.some(s => s.toLowerCase() === nuevaSubcategoria.trim().toLowerCase())) {
      setNuevaSubcategoria('');
      return;
    }
    const nuevasSubs = { ...subcategoriasIngreso, [cat]: [...actuales, nuevaSubcategoria.trim()] };
    setSubcategoriasIngreso(nuevasSubs);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, undefined, undefined, categoriasIngreso, nuevasSubs);
    setNuevaSubcategoria('');
  };

  const eliminarSubcategoriaConfig = (tipo, cat, sub) => {
    if (tipo === 'ingreso') {
      const nuevasSubs = {
        ...subcategoriasIngreso,
        [cat]: (subcategoriasIngreso[cat] || []).filter(s => s !== sub)
      };
      setSubcategoriasIngreso(nuevasSubs);
      guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, subcategoriasGasto, undefined, undefined, categoriasIngreso, nuevasSubs);
      return;
    }
    const nuevasSubs = {
      ...subcategoriasGasto,
      [cat]: (subcategoriasGasto[cat] || []).filter(s => s !== sub)
    };
    setSubcategoriasGasto(nuevasSubs);
    guardarConfigFinanzas(categoriasGasto, billeterasFinanzas, nuevasSubs);
  };

  const movimientosMesActual = movimientosFinanzas.filter(m => {
    const mesMov = m.fecha ? m.fecha.slice(0, 7) : '';
    const esRecurrenteEn = esRepetitivo(m) && m.fecha && (m.fecha.slice(0, 7) <= idMesActivo) &&
      (obtenerCuotaParaMes(m, idMesActivo) !== null);
    return mesMov === idMesActivo || esRecurrenteEn;
  }).sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.ts || 0) - (a.ts || 0));

  const totalGastosMes = movimientosMesActual.filter(m => m.tipo === 'gasto').reduce((acc, m) => acc + valorMovimientoEnMes(m, idMesActivo), 0);
  const totalIngresosMes = movimientosMesActual.filter(m => m.tipo === 'ingreso').reduce((acc, m) => acc + valorMovimientoEnMes(m, idMesActivo), 0);

  const formatearFechaLegible = (iso) => {
    const [y, mo, d] = (iso || '').slice(0, 10).split('-').map(Number);
    if (!y || !mo || !d) return iso;
    return new Date(y, mo - 1, d).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  };

  // Próximo gasto a pagar: la próxima ocurrencia de un gasto (recurrente o de una sola vez)
  // cuya fecha de vencimiento sea hoy o futura, eligiendo la más cercana.
  const proximoGastoAVencer = (() => {
    const hoyISO = hoyComoStr();
    const candidatos = [];
    movimientosFinanzas.forEach(m => {
      if (!m || m.tipo !== 'gasto' || !m.fecha) return;
      const partes = (m.fecha || '').slice(0, 10).split('-').map(Number);
      const diaOrig = partes[2] || 1;
      if (!partes[0] || !partes[1]) return;
      let fechaDue = null;
      let monto = 0;
      let cuotaNro = null;
      let totalCuotas = null;
      if (esRepetitivo(m)) {
        let yy = fecha.año;
        let mm = fecha.mesIndex + 1;
        let cuotaVista = false;
        let guard = 0;
        while (guard < 600) {
          const mesId = `${yy}-${String(mm).padStart(2, '0')}`;
          const cuota = obtenerCuotaParaMes(m, mesId);
          if (cuota !== null) {
            const ultDia = new Date(yy, mm, 0).getDate();
            const due = `${mesId}-${String(Math.min(diaOrig, ultDia)).padStart(2, '0')}`;
            if (due >= hoyISO) {
              fechaDue = due;
              monto = valorMovimientoEnMes(m, mesId);
              cuotaNro = cuota;
              totalCuotas = m.totalCuotas || null;
              break;
            }
            if (m.frecuencia !== 'fijo' && cuota >= (m.totalCuotas || 1)) break;
            cuotaVista = true;
          } else if (cuotaVista) {
            break;
          } else if (m.frecuencia !== 'fijo' && m.totalCuotas) {
            const mesesTermino = partes[0] * 12 + partes[1] + (m.totalCuotas - 1);
            if (yy * 12 + mm > mesesTermino) break;
          }
          mm += 1;
          if (mm > 12) { mm = 1; yy += 1; }
          guard += 1;
        }
      } else {
        const due = (m.fecha || '').slice(0, 10);
        if (due > hoyISO) {
          fechaDue = due;
          monto = Number(m.monto) || 0;
        }
      }
      if (fechaDue) {
        candidatos.push({ fechaDue, monto, label: m.descripcion || m.categoria || 'Gasto', cuotaNro, totalCuotas });
      }
    });
    candidatos.sort((a, b) => a.fechaDue.localeCompare(b.fechaDue));
    return candidatos[0] || null;
  })();

  const saldoBilleteras = billeterasFinanzas.map(b => ({ nombre: b, saldo: saldoBilletera(b, movimientosFinanzas, fecha.idMes) }));
  const totalBilleteras = saldoBilleteras.reduce((a, x) => a + x.saldo, 0);
  const totalReservas = saldoBilleteras.filter(x => billeterasReserva.includes(x.nombre)).reduce((a, x) => a + x.saldo, 0);
  const totalDisponible = totalBilleteras - totalReservas;

  // ===== BOTÓN 1: INICIAR JORNADA =====
  const abrirIniciarJornada = () => {
    const diaObj = dias[diaSeleccionado - 1] || {};
    if (diaObj.estadoJornada === 'activa' || diaObj.estadoJornada === 'pausada') return alert('Ya hay una jornada iniciada o pausada hoy.');
    if (diaObj.esFranco) return alert('Hoy es tu día franco asignado. Cancelalo desde el cartel de franco si querés trabajar.');
    if (diaObj.real !== null && diaObj.estadoJornada === 'finalizada') return alert('El día ya está cerrado. Reabrilo desde la tarjeta para corregirlo.');
    if (tieneEventosJornada(diaObj) && !confirm('Ya hay registros de una jornada hoy. ¿Iniciar de nuevo? Se borrarán los registros anteriores.')) return;

    setJornadaHoraInicio(horaActual());
    const kmPrevio = obtenerUltimoKmGlobal(dias, diaSeleccionado);
    setJornadaKmInicio(kmPrevio !== null ? String(kmPrevio) : '');
    setShowIniciarModal(true);
  };

  const guardarIniciarJornada = () => {
    if (!jornadaHoraInicio || horaAMinutos(jornadaHoraInicio) === null) return alert('Ingresá una hora de inicio válida.');
    const kmFloat = parseFloat(jornadaKmInicio);
    if (isNaN(kmFloat) || kmFloat <= 0) return alert('Ingresá el kilometraje actual del auto.');
    const kmPrevio = obtenerUltimoKmGlobal(dias, diaSeleccionado);
    if (!validarKmContraUltimo(kmFloat, kmPrevio)) return;

    let nuevosDias = [...dias];
    nuevosDias[diaSeleccionado - 1] = {
      ...nuevosDias[diaSeleccionado - 1],
      estadoJornada: 'activa',
      inicio: { hora: jornadaHoraInicio, km: kmFloat },
      pausas: [],
      fin: null
    };
    aplicarDias(nuevosDias);
    setJornadaHoraInicio('');
    setJornadaKmInicio('');
    setShowIniciarModal(false);
  };

  // ===== BOTÓN 2: PAUSAR / RETOMAR JORNADA =====
  const abrirPausaRetomar = () => {
    const diaObj = dias[diaSeleccionado - 1] || {};
    const estado = diaObj.estadoJornada;
    if (!estado) return alert('Primero iniciá la jornada.');
    if (estado === 'finalizada') return alert('La jornada ya finalizó. Reabrí el día para corregir los datos.');

    if (estado === 'activa') {
      setModoPausaRetomar('pausar');
      const acum = acumuladoJornada(diaObj);
      setPausaUber(acum.uber > 0 ? String(Math.round(acum.uber)) : '');
      setPausaDidi(acum.didi > 0 ? String(Math.round(acum.didi)) : '');
    } else {
      setModoPausaRetomar('retomar');
      setPausaUber('');
      setPausaDidi('');
    }
    setPausaHora(horaActual());
    const ultKm = ultimoKmJornada(diaObj);
    setPausaKm(ultKm !== null ? String(ultKm) : '');
    setShowPausaRetomarModal(true);
  };

  const guardarPausaRetomar = () => {
    const esPausa = modoPausaRetomar === 'pausar';
    const diaObj = dias[diaSeleccionado - 1] || {};
    if (!diaObj.estadoJornada || diaObj.estadoJornada === 'finalizada') return alert('No hay una jornada en curso para pausar o retomar.');

    if (!pausaHora || horaAMinutos(pausaHora) === null) return alert('Ingresá una hora válida.');
    const kmFloat = parseFloat(pausaKm);
    if (isNaN(kmFloat) || kmFloat <= 0) return alert('Ingresá el kilometraje actual del auto.');
    if (!validarKmContraUltimo(kmFloat, ultimoKmJornada(diaObj))) return;
    if (esPausa) {
      const uber = parseFloat(pausaUber) || 0;
      const didi = parseFloat(pausaDidi) || 0;
      if (uber <= 0 && didi <= 0) return alert('Ingresá al menos un monto (Uber o DiDi) para registrar la pausa.');
    }

    const evs = eventosJornada(diaObj);
    if (evs.length > 0) {
      const ultimaHoraMin = horaAMinutos(evs[evs.length - 1].hora);
      const nuevaHoraMin = horaAMinutos(pausaHora);
      if (ultimaHoraMin !== null && nuevaHoraMin < ultimaHoraMin) {
        return alert(`La hora no puede ser anterior al último registro de la jornada (${evs[evs.length - 1].hora}).`);
      }
    }

    const nuevoEvento = esPausa
      ? { tipo: 'pausa', hora: pausaHora, km: kmFloat, uber: parseFloat(pausaUber) || 0, didi: parseFloat(pausaDidi) || 0 }
      : { tipo: 'retomar', hora: pausaHora, km: kmFloat };

    let nuevosDias = [...dias];
    nuevosDias[diaSeleccionado - 1] = {
      ...diaObj,
      pausas: [...(Array.isArray(diaObj.pausas) ? diaObj.pausas : []), nuevoEvento],
      estadoJornada: esPausa ? 'pausada' : 'activa'
    };
    aplicarDias(nuevosDias);
    setPausaUber('');
    setPausaDidi('');
    setPausaHora('');
    setPausaKm('');
    setShowPausaRetomarModal(false);
  };

  // ===== BOTÓN 3: FINALIZAR JORNADA =====
  const abrirFinalizar = () => {
    const diaObj = dias[diaSeleccionado - 1] || {};
    if (!diaObj.estadoJornada) return alert('Primero iniciá la jornada para poder finalizarla.');

    const acum = acumuladoJornada(diaObj);
    setFinUber(acum.uber > 0 ? String(Math.round(acum.uber)) : '');
    setFinDidi(acum.didi > 0 ? String(Math.round(acum.didi)) : '');
    setFinHora(horaActual());
    const ultKm = ultimoKmJornada(diaObj);
    setFinKm(ultKm !== null ? String(ultKm) : '');
    setShowFinalizarModal(true);
  };

  const guardarFinalizar = () => {
    const diaObj = dias[diaSeleccionado - 1];
    if (!diaObj || !diaObj.estadoJornada) return alert('No hay una jornada iniciada hoy.');

    const uber = parseFloat(finUber) || 0;
    const didi = parseFloat(finDidi) || 0;
    const total = uber + didi;
    if (total <= 0) return alert('Ingresá el monto facturado en Uber o DiDi para cerrar el día.');
    if (!finHora || horaAMinutos(finHora) === null) return alert('Ingresá una hora de finalización válida.');
    const kmFloat = parseFloat(finKm);
    if (isNaN(kmFloat) || kmFloat <= 0) return alert('Ingresá el kilometraje actual del auto.');
    if (!validarKmContraUltimo(kmFloat, ultimoKmJornada(diaObj))) return;

    const horaFinMin = horaAMinutos(finHora);
    const horaInicioMin = horaAMinutos(diaObj.inicio?.hora);
    if (horaInicioMin !== null && horaFinMin <= horaInicioMin) return alert('La hora de finalización debe ser posterior a la hora de inicio.');

    const horasCalc = calcularHorasJornada({ inicio: diaObj.inicio, pausas: diaObj.pausas, fin: { hora: finHora } });

    let nuevosDias = [...dias];
    nuevosDias[diaSeleccionado - 1] = {
      ...diaObj,
      fin: { hora: finHora, km: kmFloat },
      estadoJornada: 'finalizada',
      real: total,
      uber: uber > 0 ? uber : null,
      didi: didi > 0 ? didi : null,
      horas: horasCalc > 0 ? horasCalc : null,
      parcialUber: null,
      parcialDidi: null,
      parcialHoras: null
    };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);

    aplicarDias(nuevosDias);
    setFinUber('');
    setFinDidi('');
    setFinHora('');
    setFinKm('');
    setShowFinalizarModal(false);
  };

  // Cerrar el día como franco / sin trabajo ($0)
  const cerrarDiaSinTrabajo = () => {
    if (!confirm('¿Cerrar hoy como día libre sin ingresos? Se marcará con $0.')) return;
    let nuevosDias = [...dias];
    nuevosDias[diaSeleccionado - 1] = {
      ...nuevosDias[diaSeleccionado - 1],
      real: 0,
      uber: null,
      didi: null,
      horas: null
    };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);
    setDias(nuevosDias);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  const reabrirDia = () => {
    let nuevosDias = [...dias];
    const diaObj = nuevosDias[diaSeleccionado - 1];
    nuevosDias[diaSeleccionado - 1] = {
      ...diaObj,
      real: null,
      uber: null,
      didi: null,
      horas: null,
      esFranco: null
    };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);
    setDias(nuevosDias);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  // ===== SISTEMA DE FRANCO POR EXCEDENTE =====
  const validarDiaParaFranco = (diaNum) => {
    const diaObj = dias[diaNum - 1];
    if (!diaObj) return 'Día inexistente.';
    if (diaNum < fecha.diaHoy) return 'No podés asignar un franco a un día que ya pasó.';
    if (diaObj.real !== null && !diaObj.esFranco) return 'Ese día ya está cerrado con monto cargado.';
    if (diaNum === fecha.diaHoy && (diaObj.estadoJornada === 'activa' || diaObj.estadoJornada === 'pausada')) return 'Tenés una jornada en curso hoy. Finalizala o cerrala antes de asignar el franco.';
    return null;
  };

  // Asigna (o mueve) el franco al día indicado: queda como $0 y la curva redistribuye su meta.
  const guardarFechaFranco = (diaNum) => {
    const error = validarDiaParaFranco(diaNum);
    if (error) return alert(error);

    let nuevosDias = [...dias];
    const idxViejo = nuevosDias.findIndex(d => d && d.esFranco);
    if (idxViejo !== -1) {
      nuevosDias[idxViejo] = { ...nuevosDias[idxViejo], real: null, uber: null, didi: null, horas: null, esFranco: null };
    }
    const idx = diaNum - 1;
    nuevosDias[idx] = { ...nuevosDias[idx], real: 0, esperado: 0, uber: null, didi: null, horas: null, esFranco: true };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);
    setDias(nuevosDias);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  const cancelarFranco = () => {
    const idxViejo = dias.findIndex(d => d && d.esFranco);
    if (idxViejo === -1) return;
    let nuevosDias = [...dias];
    nuevosDias[idxViejo] = { ...nuevosDias[idxViejo], real: null, uber: null, didi: null, horas: null, esFranco: null };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);
    setDias(nuevosDias);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  const iniciarEdicion = (d) => {
    setDiaEnEdicion(d.dia);
    setEdicionUber(d.uber != null ? d.uber.toString() : '');
    setEdicionDidi(d.didi != null ? d.didi.toString() : '');
    setEdicionHoras(d.horas !== null && d.horas !== undefined ? d.horas.toString() : '');
    setEdicionUberParcial(d.parcialUber ? d.parcialUber.toString() : '');
    setEdicionDidiParcial(d.parcialDidi ? d.parcialDidi.toString() : '');
    setEdicionHorasParcial(d.parcialHoras ? d.parcialHoras.toString() : '');
    if (tieneEventosJornada(d)) {
      setEditJornadaData({
        inicioHora: d.inicio?.hora || '',
        inicioKm: d.inicio?.km !== undefined && d.inicio?.km !== null ? String(d.inicio.km) : '',
        eventos: (Array.isArray(d.pausas) ? d.pausas : []).filter(p => p).map(p => ({ ...p })),
        finHora: d.fin?.hora || '',
        finKm: d.fin?.km !== undefined && d.fin?.km !== null ? String(d.fin.km) : ''
      });
    } else {
      setEditJornadaData(null);
    }
  };

  const actualizarCampoEditJornada = (campo, valor) => {
    setEditJornadaData(prev => ({ ...prev, [campo]: valor }));
  };

  const actualizarEventoEdicion = (index, campo, valor) => {
    setEditJornadaData(prev => ({
      ...prev,
      eventos: prev.eventos.map((ev, i) => (i === index ? { ...ev, [campo]: valor } : ev))
    }));
  };

  const quitarEventoEdicion = (index) => {
    setEditJornadaData(prev => ({
      ...prev,
      eventos: prev.eventos.filter((_, i) => i !== index)
    }));
  };

  const guardarEdicionJornada = () => {
    const uber = parseFloat(edicionUber) || 0;
    const didi = parseFloat(edicionDidi) || 0;
    const total = uber + didi;

    const secuencia = [{ tipo: 'inicio', hora: editJornadaData.inicioHora, km: editJornadaData.inicioKm }];
    editJornadaData.eventos.forEach(ev => secuencia.push({ tipo: ev.tipo, hora: ev.hora, km: ev.km, uber: ev.uber, didi: ev.didi }));
    if (editJornadaData.finHora !== '' || editJornadaData.finKm !== '') {
      secuencia.push({ tipo: 'fin', hora: editJornadaData.finHora, km: editJornadaData.finKm });
    }

    let ultimoKm = null;
    for (const ev of secuencia) {
      if (!ev.hora || horaAMinutos(ev.hora) === null) return alert('Hay horarios vacíos o inválidos en la jornada. Completalos o borrá el registro con la ✕.');
      const kmNum = parseFloat(ev.km);
      if (isNaN(kmNum) || kmNum <= 0) return alert('Hay kilometrajes vacíos o inválidos en la jornada. Completalos o borrá el registro con la ✕.');
      if (ultimoKm !== null && kmNum < ultimoKm) return alert(`Los kilometrajes deben ir en orden creciente. Revisá el registro de las ${ev.hora}.`);
      ultimoKm = kmNum;
    }

    const eventoInicio = secuencia[0];
    const nuevoInicioObj = { hora: eventoInicio.hora, km: parseFloat(eventoInicio.km) };
    const nuevasPausas = secuencia
      .filter(e => e.tipo === 'pausa' || e.tipo === 'retomar')
      .map(e => {
        const base = { tipo: e.tipo, hora: e.hora, km: parseFloat(e.km) };
        if (e.tipo === 'pausa') {
          base.uber = parseFloat(e.uber) || 0;
          base.didi = parseFloat(e.didi) || 0;
        }
        return base;
      });
    const eventoFin = secuencia.find(e => e.tipo === 'fin');
    const nuevoFinObj = eventoFin ? { hora: eventoFin.hora, km: parseFloat(eventoFin.km) } : null;

    const horasCalc = calcularHorasJornada({ inicio: nuevoInicioObj, pausas: nuevasPausas, fin: nuevoFinObj });

    if (total <= 0 && horasCalc <= 0) {
      if (!confirm('¿Cerrar este día sin ingresos ni horas? Se marcará como cerrado en $0.')) return;
    }

    let nuevosDias = [...dias];
    nuevosDias[diaEnEdicion - 1] = {
      ...nuevosDias[diaEnEdicion - 1],
      inicio: nuevoInicioObj,
      pausas: nuevasPausas,
      fin: nuevoFinObj,
      estadoJornada: nuevoFinObj ? 'finalizada' : 'activa',
      real: total,
      uber: uber > 0 ? uber : null,
      didi: didi > 0 ? didi : null,
      horas: horasCalc > 0 ? horasCalc : null,
      esFranco: null
    };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);

    setDias(nuevosDias);
    setDiaEnEdicion(null);
    setEditJornadaData(null);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  const guardarEdicion = () => {
    if (editJornadaData) return guardarEdicionJornada();

    const uber = parseFloat(edicionUber) || 0;
    const didi = parseFloat(edicionDidi) || 0;
    const horasStr = edicionHoras;
    const horasFloat = parseFloat(horasStr);
    const horas = isNaN(horasFloat) ? 0 : horasFloat;
    const total = uber + didi;

    if (total <= 0 && horas <= 0) {
      if (!confirm('¿Cerrar este día sin ingresos ni horas? Se marcará como cerrado en $0.')) return;
    }
    if (horasStr !== '' && isNaN(horasFloat)) return alert("Ingresá un valor numérico válido en Horas.");
    if (horasFloat === 0 && horasStr !== '') return alert("Si declarás Horas en la edición, no puede ser 0. Dejá el campo vacío si no se trabajó este día.");

    const parcialUber = parseFloat(edicionUberParcial) || 0;
    const parcialDidi = parseFloat(edicionDidiParcial) || 0;
    const parcialHorasStr = edicionHorasParcial;
    const parcialHorasFloat = parseFloat(parcialHorasStr);
    const parcialHoras = isNaN(parcialHorasFloat) ? 0 : parcialHorasFloat;

    if (parcialHorasStr !== '' && isNaN(parcialHorasFloat)) return alert("Ingresá un valor numérico válido en Horas parciales.");
    if (parcialHorasFloat === 0) return alert("Si declarás Horas parciales, no puede ser 0. Dejá el campo vacío si no querés registrar horas parciales.");

    let nuevosDias = [...dias];
    nuevosDias[diaEnEdicion - 1] = {
      ...nuevosDias[diaEnEdicion - 1],
      real: total,
      uber: uber > 0 ? uber : null,
      didi: didi > 0 ? didi : null,
      horas: horasStr === '' ? null : (horas > 0 ? horas : null),
      parcialUber: parcialUber > 0 ? parcialUber : null,
      parcialDidi: parcialDidi > 0 ? parcialDidi : null,
      parcialHoras: parcialHorasStr === '' ? null : (parcialHoras > 0 ? parcialHoras : null),
      esFranco: null
    };
    nuevosDias = recalcularCurva(nuevosDias, metaTotal);

    setDias(nuevosDias);
    setDiaEnEdicion(null);
    guardarEnFirebase(metaTotal, nuevosDias);
  };

  const guardarConfiguracion = () => {
    const m = parseFloat(nuevaMeta);
    if (isNaN(m) || m <= 0) return alert("Ingresá un valor válido.");

    // Mantiene los días ya cargados y recalcula la curva de los días restantes con la nueva meta
    const nuevosDias = recalcularCurva(dias, m);
    setMetaTotal(m);
    setDias(nuevosDias);
    setModoConfig(false);
    guardarEnFirebase(m, nuevosDias);
  };

  const toggleMesComparacion = (idMes) => {
    if (mesesComparados.includes(idMes)) {
      setMesesComparados(mesesComparados.filter(m => m !== idMes));
    } else {
      setMesesComparados([...mesesComparados, idMes]);
    }
  };

  const curvaIdeal = generarCurvaIdeal(metaTotal, dias.length);
  const datosGrafico = dias.map((d, index) => {
    const acumuladoRealHastaHoy = dias.slice(0, index + 1).reduce((acc, curr) => acc + (curr.real || 0), 0);
    
    let objetoPunto = {
      dia: `${d.dia}`,
      Esperado: curvaIdeal[index] || 0,
      Real: d.real !== null ? acumuladoRealHastaHoy : null 
    };

    mesesComparados.forEach(idMesHist => {
      const mesData = mesesHistoricos[idMesHist];
      if (mesData && mesData.dias && mesData.dias[index]) {
        const acumuladoHist = mesData.dias.slice(0, index + 1).reduce((acc, curr) => acc + (curr.real || 0), 0);
        objetoPunto[idMesHist] = acumuladoHist > 0 ? acumuladoHist : null;
      }
    });

    return objetoPunto;
  });

  const datosHoras = dias.map(d => ({
    dia: `${d.dia}`,
    horas: Number(d.horas) || 0,
    total: Number(d.real) || 0
  }));

  const datosDineroHora = dias.map(d => {
    const horas = Number(d.horas) || 0;
    const total = Number(d.real) || 0;
    return {
      dia: `${d.dia}`,
      dineroHora: horas > 0 ? Math.round(total / horas) : 0,
      horas,
      total
    };
  });

  const diasConHoras = dias.filter(d => Number(d.horas) > 0);
  const promedioHoras = diasConHoras.length > 0
    ? (diasConHoras.reduce((acc, d) => acc + Number(d.horas), 0) / diasConHoras.length).toFixed(1)
    : '0';

  const diasCerrados = dias.filter(d => d.real !== null && Number(d.real) > 0);
  const promedioGananciaHora = diasConHoras.length > 0
    ? Math.round(diasConHoras.reduce((acc, d) => acc + (Number(d.real) / Number(d.horas)), 0) / diasConHoras.length)
    : 0;
  const promedioGananciaDia = diasCerrados.length > 0
    ? Math.round(diasCerrados.reduce((acc, d) => acc + Number(d.real), 0) / diasCerrados.length)
    : 0;

  const coloresComparacion = ['#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6'];

  if (cargando) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center font-sans">
        <p className="text-gray-500 font-medium animate-pulse">Cargando datos y planificación...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 font-sans text-gray-800 pb-24 overflow-x-hidden" onTouchStart={handleTouchStart} onTouchMove={handleTouchMove} onTouchEnd={handleTouchEnd}>
      <div className="p-4 max-w-md mx-auto mt-2">
        
        <div className="flex justify-between items-center mb-6">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-slate-900">
              {seccion === 'trabajo' ? 'Plan de Ganancias' : seccion === 'finanzas' ? 'Finanzas' : seccion === 'vehiculo' ? 'Vehículo' : 'Inicio'}
            </h1>
            <p className="text-sm text-gray-500 capitalize">{seccion === 'trabajo' ? fecha.nombreMes : 'Resumen general'}</p>
          </div>
          {seccion === 'trabajo' && vistaActual === 'planificador' && (
            <button 
              onClick={() => setModoConfig(!modoConfig)} 
              className="text-sm bg-white border border-gray-200 px-4 py-2 rounded-none font-medium shadow-sm hover:bg-gray-100 transition-colors"
            >
              {modoConfig ? '✕ Volver' : '⚙️ Ajustes'}
            </button>
          )}
          {seccion === 'dashboard' && (
            <button 
              onClick={() => setShowConfigModal(true)} 
              className="text-sm bg-white border border-gray-200 px-4 py-2 rounded-none font-medium shadow-sm hover:bg-gray-100 transition-colors"
            >
              ⚙️ Configuración
            </button>
          )}
        </div>

        {/* --- DASHBOARD --- */}
        {seccion === 'dashboard' && (
          <div className="space-y-4">
            <p className="text-gray-500 text-sm">Tocá una tarjeta para ir a esa sección.</p>
            <button
              onClick={() => cambiarSeccion('vehiculo')}
              className="w-full text-left bg-white rounded-none shadow-sm border border-gray-200 p-5 flex items-center justify-between hover:bg-gray-100 transition-colors"
            >
              <div>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">🚗 Vehículo</div>
                <div className="text-xl font-bold text-slate-800 mt-1">{resumenVehiculo}</div>
              </div>
              <span className="text-2xl">🚗</span>
            </button>
            <button
              onClick={() => cambiarSeccion('finanzas')}
              className="w-full text-left bg-white rounded-none shadow-sm border border-gray-200 p-5 flex items-center justify-between hover:bg-gray-100 transition-colors"
            >
              <div>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">💰 Finanzas</div>
                <div className="text-xl font-bold text-slate-800 mt-1">
                  {proximoGastoAVencer
                    ? `Próximo: ${proximoGastoAVencer.label} ${formatearDinero(proximoGastoAVencer.monto)}`
                    : 'Sin gastos a vencer'}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">
                  {proximoGastoAVencer
                    ? `Vence el ${formatearFechaLegible(proximoGastoAVencer.fechaDue)}${proximoGastoAVencer.cuotaNro ? ` · cuota ${proximoGastoAVencer.cuotaNro}/${proximoGastoAVencer.totalCuotas}` : ''}`
                    : 'No hay gastos programados'}
                </div>
              </div>
              <span className="text-2xl">💰</span>
            </button>
            <button
              onClick={() => cambiarSeccion('trabajo')}
              className="w-full text-left bg-white rounded-none shadow-sm border border-gray-200 p-5 flex items-center justify-between hover:bg-gray-100 transition-colors"
            >
              <div>
                <div className="text-xs font-semibold text-gray-400 uppercase tracking-wide">📝 Trabajo</div>
                <div className="text-xl font-bold text-slate-800 mt-1">Objetivo de hoy: {formatearDinero(objetivoHoy)}</div>
              </div>
              <span className="text-2xl">📝</span>
            </button>
          </div>
        )}

        {/* --- VISTA 1: PLANIFICADOR --- */}
        {seccion === 'trabajo' && vistaActual === 'planificador' && (
          <div className={tabAnimClass}>
            {modoConfig ? (
              <div className="space-y-6">
                <div className="bg-white rounded-none shadow-sm border border-blue-200 p-6">
                  <h3 className="font-bold text-lg mb-4 text-slate-800">Ajustes del Mes Actual</h3>
                  <div className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-600 mb-1">Nueva Meta Mensual ($)</label>
                      <input 
                        type="number" 
                        inputMode="numeric"
                        value={nuevaMeta}
                        onChange={(e) => setNuevaMeta(e.target.value)}
                        className="w-full p-3 bg-gray-50 border border-gray-200 rounded-none outline-none"
                      />
                      <p className="text-xs text-gray-400 mt-1.5">
                        Se mantienen los días ya cargados y se recalculan los montos de los días restantes.
                      </p>
                    </div>
                    <button 
                      onClick={guardarConfiguracion}
                      className="w-full bg-slate-900 text-white font-semibold py-3 rounded-none hover:bg-slate-800 transition-all"
                    >
                      Actualizar Meta y Recalcular Días
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {esDiaDeAltaDemanda && (
                  <div className="bg-gradient-to-r from-sky-500 to-blue-600 text-white rounded-none p-5 mb-6 shadow-md border border-sky-300 flex items-center gap-4">
                    <span className="text-4xl animate-pulse">🌧️</span>
                    <div>
                      <p className="font-bold text-base leading-tight">¡Día de Alta Demanda en la Calle!</p>
                      <p className="text-xs text-sky-100 mt-1">
                        Pronóstico de lluvia ({climaHoy.probLluvia}% prob.) y frío ({climaHoy.tempMax}°C máx). ¡Aprovechá a facturar fuerte hoy!
                      </p>
                    </div>
                  </div>
                )}

                {(diaFrancoAsignado || puedeFranco) && (
                  <button
                    onClick={() => {
                      setDiaFrancoTemporal(diaFrancoAsignado ? diaFrancoAsignado.dia : null);
                      setShowFrancoModal(true);
                    }}
                    className="w-full text-left bg-gradient-to-r from-green-500 to-emerald-600 text-white rounded-none p-5 mb-6 shadow-md border border-green-400 flex items-center gap-4 hover:from-green-600 hover:to-emerald-700 transition-colors active:scale-[0.99]"
                  >
                    <span className="text-4xl drop-shadow-sm animate-bounce">🎮</span>
                    <div className="flex-1">
                      {diaFrancoAsignado ? (
                        <>
                          <p className="font-bold text-lg leading-tight">
                            {diaFrancoAsignado.dia === fecha.diaHoy ? '¡Hoy es tu Día Franco!' : 'Franco Asignado'}
                          </p>
                          <p className="text-sm text-green-50 mt-1">
                            {diaFrancoAsignado.dia === fecha.diaHoy
                              ? 'Descansá tranquilo: el excedente que acumulaste cubre el día de hoy.'
                              : <>Tu libre está fijado para el <strong>{obtenerNombreDia(diaFrancoAsignado.dia, fecha.año, fecha.mesIndex)}</strong>. Tocá acá para cambiar la fecha o cancelarlo.</>}
                          </p>
                        </>
                      ) : (
                        <>
                          <p className="font-bold text-lg leading-tight">¡Día Franco Desbloqueado!</p>
                          <p className="text-sm text-green-50 mt-1">
                            Excedente acumulado: <strong>{formatearDinero(excedenteAcumulado)}</strong> · Meta del próximo día: <strong>{formatearDinero(proximoDiaPendiente?.esperado || 0)}</strong>. Tocá para asignarlo.
                          </p>
                        </>
                      )}
                    </div>
                    <span className="text-xl opacity-80">›</span>
                  </button>
                )}

                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-6 mb-6">
                  <div className="flex justify-between items-center mb-2">
                    <h2 className="text-xs text-gray-400 uppercase tracking-widest font-semibold">
                      {obtenerNombreDia(fecha.diaHoy, fecha.año, fecha.mesIndex)}
                    </h2>
                    <span className="text-xs font-bold text-gray-400">({fecha.totalDias} días en total)</span>
                  </div>

                  {climaHoy && (
                    <div 
                      onClick={() => setDiaModalSeleccionado(fecha.diaHoy)}
                      className="my-3 bg-sky-50 border border-sky-200 p-3 rounded-none flex items-center justify-between cursor-pointer hover:bg-sky-100 transition-colors"
                      title="Ver pronóstico detallado"
                    >
                      <div className="flex items-center gap-2.5 text-xs text-sky-900 font-semibold">
                        <span className="text-2xl">{obtenerIconoClima(climaHoy.codigo, climaHoy.probLluvia)}</span>
                        <div>
                          <p className="font-bold text-slate-800">Mín {Math.round(climaHoy.tempMin)}°C / Máx {Math.round(climaHoy.tempMax)}°C</p>
                          <p className="text-[11px] text-sky-700 font-normal">Lluvia: {climaHoy.probLluvia}% ({climaHoy.lluvia} mm)</p>
                        </div>
                      </div>
                      <span className="text-xs text-blue-600 font-bold hover:underline">Ver horas →</span>
                    </div>
                  )}
                  
                   {yaCargadoHoy ? (
                      <div className="text-center py-4">
                        <p className="text-xl font-bold text-green-600 mb-2">¡Día cerrado!</p>
                        <p className="text-gray-500 text-sm mb-4">Podés editarlo desde el historial si te equivocaste.</p>
                        <button
                          onClick={() => { if (confirm('¿Reabrir este día? Se borrarán los datos de cierre.')) reabrirDia(); }}
                          className="text-sm text-red-500 hover:text-red-700 underline font-medium"
                        >
                          Reabrir día
                        </button>
                      </div>
                  ) : (
                    <>
                      {tieneEventosJornada(diaHoyObj) && (
                        <div className={`border p-3 rounded-none mb-4 ${estadoJornadaHoy === 'pausada' ? 'bg-amber-50 border-amber-200' : 'bg-emerald-50 border-emerald-200'}`}>
                          <div className="flex justify-between items-center mb-2">
                            <p className={`text-[11px] font-bold uppercase tracking-wider ${estadoJornadaHoy === 'pausada' ? 'text-amber-700' : 'text-emerald-700'}`}>
                              {estadoJornadaHoy === 'activa' && '🟢 Jornada activa'}
                              {estadoJornadaHoy === 'pausada' && '⏸️ Jornada pausada'}
                              {estadoJornadaHoy === 'finalizada' && '📋 Jornada registrada (día reabierto)'}
                              {!estadoJornadaHoy && '📋 Registros de la jornada'}
                            </p>
                          </div>
                          <div className="text-xs text-slate-800 space-y-1">
                            {diaHoyObj.inicio && (
                              <div>🕐 Inicio: <strong>{diaHoyObj.inicio.hora} hs</strong> · 🛣️ Odómetro: <strong>{formatearKm(diaHoyObj.inicio.km)}</strong></div>
                            )}
                            {(acumuladoHoy.uber > 0 || acumuladoHoy.didi > 0) && (
                              <>
                                {acumuladoHoy.uber > 0 && <div>🚗 Uber acumulado: <strong>{formatearDinero(acumuladoHoy.uber)}</strong></div>}
                                {acumuladoHoy.didi > 0 && <div>🚕 DiDi acumulado: <strong>{formatearDinero(acumuladoHoy.didi)}</strong></div>}
                                <div>💰 Subtotal del día: <strong className="text-emerald-700">{formatearDinero(acumuladoHoy.total)}</strong></div>
                              </>
                            )}
                            {horasHoyCalculadas > 0 && (
                              <div>⏱️ Horas trabajadas: <strong>{horasHoyCalculadas} hs</strong>{estadoJornadaHoy === 'activa' ? ' (+ tramo en curso)' : ''}</div>
                            )}
                          </div>
                          {(() => {
                            const kmInicio = Number(diaHoyObj.inicio?.km);
                            const ultKm = ultimoKmJornada(diaHoyObj);
                            if (isNaN(kmInicio) || kmInicio <= 0 || ultKm === null || ultKm <= kmInicio) return null;
                            return (
                              <div className="text-xs text-slate-800 mt-1">🛣️ Recorridos hoy: <strong>{formatearKm(ultKm - kmInicio)}</strong></div>
                            );
                          })()}
                          {objetivoHoy > 0 && acumuladoHoy.total > 0 && (() => {
                            const porcentaje = Math.min(100, Math.round((acumuladoHoy.total / objetivoHoy) * 100));
                            const faltante = Math.max(0, objetivoHoy - acumuladoHoy.total);
                            const superado = acumuladoHoy.total >= objetivoHoy;
                            return (
                              <div className="mt-2.5 pt-2.5 border-t border-emerald-300/60">
                                <div className="flex justify-between items-center mb-1">
                                  <span className={`text-xs font-bold ${superado ? 'text-green-700' : 'text-slate-800'}`}>
                                    {superado ? '¡Meta superada! 🎉' : `Quedan ${formatearDinero(faltante)} para tu meta`}
                                  </span>
                                  <span className={`text-xs font-semibold ${superado ? 'text-green-600' : 'text-emerald-700'}`}>{porcentaje}%</span>
                                </div>
                                <div className="w-full bg-emerald-100 rounded-full h-2.5">
                                  <div
                                    className={`h-2.5 rounded-full transition-all duration-500 ${superado ? 'bg-green-500' : 'bg-emerald-500'}`}
                                    style={{ width: `${porcentaje}%` }}
                                  />
                                </div>
                                <p className="text-[10px] text-gray-600 mt-1">
                                  Llevás {formatearDinero(acumuladoHoy.total)} de {formatearDinero(objetivoHoy)}
                                </p>
                              </div>
                            );
                          })()}
                        </div>
                      )}

                      <p className="text-sm text-gray-500 mb-1">Objetivo de hoy:</p>
                      <p className="text-4xl font-bold text-slate-800 mb-1">
                        {formatearDinero(objetivoHoy)}
                      </p>
                      {promedioGananciaHora > 0 && objetivoHoy > 0 && (() => {
                        const faltante = Math.max(0, objetivoHoy - (acumuladoHoy.total || 0));
                        const horasFaltan = Math.ceil((faltante / promedioGananciaHora) * 10) / 10;
                        return (
                          <p className="text-sm text-gray-500 mb-5">
                            ⏱️ Te faltan <strong className="text-slate-700">{horasFaltan} hs</strong> trabajando a <strong className="text-teal-600">{formatearDinero(promedioGananciaHora)}/hs</strong>
                          </p>
                        );
                      })()}

                      <div className="space-y-3">
                        <div className="flex gap-3">
                          <button
                            onClick={() => abrirIniciarJornada()}
                            disabled={!!estadoJornadaHoy}
                            className={`flex-1 h-16 flex items-center justify-center rounded-full shadow-md transition-all ${
                              estadoJornadaHoy
                                ? 'bg-gray-200 text-gray-400 cursor-not-allowed active:scale-100'
                                : 'bg-green-100 text-green-600 hover:bg-green-200 active:scale-95'
                            }`}
                          >
                            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M8 5v14l11-7z"/>
                            </svg>
                          </button>
                          <button
                            onClick={() => abrirPausaRetomar()}
                            disabled={estadoJornadaHoy !== 'activa' && estadoJornadaHoy !== 'pausada'}
                            className={`flex-1 h-16 flex items-center justify-center rounded-full shadow-md transition-all ${
                              estadoJornadaHoy !== 'activa' && estadoJornadaHoy !== 'pausada'
                                ? 'bg-gray-200 text-gray-400 cursor-not-allowed active:scale-100'
                                : 'bg-amber-100 text-amber-600 hover:bg-amber-200 active:scale-95'
                            }`}
                          >
                            {estadoJornadaHoy === 'pausada' ? (
                              <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M8 5v14l11-7z"/>
                              </svg>
                            ) : (
                              <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                                <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/>
                              </svg>
                            )}
                          </button>
                          <button
                            onClick={() => abrirFinalizar()}
                            disabled={!estadoJornadaHoy}
                            className={`flex-1 h-16 flex items-center justify-center rounded-full shadow-md transition-all ${
                              !estadoJornadaHoy
                                ? 'bg-gray-200 text-gray-400 cursor-not-allowed active:scale-100'
                                : 'bg-red-100 text-red-600 hover:bg-red-200 active:scale-95'
                            }`}
                          >
                            <svg className="w-7 h-7" fill="currentColor" viewBox="0 0 24 24">
                              <path d="M6 6h12v12H6z"/>
                            </svg>
                          </button>
                        </div>
                        {!estadoJornadaHoy && (
                          <p className="text-[11px] text-gray-400 text-center px-2">
                            ¿No trabajás hoy?{' '}
                            <button onClick={cerrarDiaSinTrabajo} className="underline hover:text-gray-600">
                              Marcar como día libre
                            </button>
                          </p>
                        )}
                      </div>
                    </>
                  )}
                </div>

                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-6 mb-6">
                  <div className="flex justify-between items-center mb-4 border-b border-gray-50 pb-4">
                    <span className="text-gray-500 font-medium">Acumulado Real</span>
                    <span className="font-bold text-lg text-green-600">{formatearDinero(acumuladoReal)}</span>
                  </div>
                  <div className="flex justify-between items-center mb-4 border-b border-gray-50 pb-4">
                    <span className="text-gray-500 font-medium">Falta para la meta</span>
                    <span className="font-bold text-lg text-orange-500">{formatearDinero(Math.max(0, metaRestante))}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500 font-medium">Meta Mensual</span>
                    <span className="font-bold text-lg">{formatearDinero(metaTotal)}</span>
                  </div>
                </div>

                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
                  <h3 className="font-bold text-lg mb-2 px-2 text-slate-800">Historial del mes</h3>
                  <p className="text-xs text-gray-400 px-2 mb-4">Tocá el ícono del clima de cualquier día para ver el detalle completo.</p>
                  
                  <div className="space-y-3">
                    {dias.map((d) => {
                      const climaDelDia = climaPronostico[d.dia];
                      const iconoClima = climaDelDia ? obtenerIconoClima(climaDelDia.codigo, climaDelDia.probLluvia) : '☁️';

                      return (
                        <div 
                          key={d.dia} 
                          className={`p-4 rounded-none flex justify-between items-center border transition-all ${
                            d.real !== null 
                              ? 'bg-gray-50 border-gray-200' 
                              : d.dia === fecha.diaHoy 
                                ? 'bg-blue-50 border-blue-200 shadow-sm' 
                                : 'bg-white border-dashed border-gray-200'
                          }`}
                        >
                          {diaEnEdicion === d.dia ? (
                            <div className="w-full space-y-2.5 bg-white p-3 border border-blue-200">
                              <div className="flex justify-between items-center border-b border-gray-100 pb-2">
                                <span className="font-bold text-slate-800 text-xs">
                                  Editar {obtenerNombreDia(d.dia, fecha.año, fecha.mesIndex)}
                                </span>
                                <div className="flex gap-1.5">
                                  <button onClick={guardarEdicion} className="px-3 py-1 bg-green-600 text-white rounded-none font-bold text-xs hover:bg-green-700">Guardar ✓</button>
                                  <button onClick={() => { setDiaEnEdicion(null); setEditJornadaData(null); }} className="px-3 py-1 bg-gray-400 text-white rounded-none font-bold text-xs hover:bg-gray-500">✕</button>
                                </div>
                              </div>
                              <div>
                                <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Datos del cierre del día</p>
                                <div className={`grid gap-2 text-xs ${editJornadaData ? 'grid-cols-2' : 'grid-cols-3'}`}>
                                  <div>
                                    <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🚗 Uber ($)</label>
                                    <input
                                      type="number"
                                      inputMode="numeric"
                                      value={edicionUber}
                                      onChange={(e) => setEdicionUber(e.target.value)}
                                      className="w-full p-2 bg-gray-50 border border-gray-300 rounded-none outline-none font-bold text-right"
                                      placeholder="0"
                                      autoFocus
                                    />
                                  </div>
                                  <div>
                                    <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🚕 DiDi ($)</label>
                                    <input
                                      type="number"
                                      inputMode="numeric"
                                      value={edicionDidi}
                                      onChange={(e) => setEdicionDidi(e.target.value)}
                                      className="w-full p-2 bg-gray-50 border border-gray-300 rounded-none outline-none font-bold text-right"
                                      placeholder="0"
                                    />
                                  </div>
                                  {!editJornadaData && (
                                    <div>
                                      <label className="block text-[10px] text-gray-500 font-bold mb-0.5">⏱️ Horas (hs)</label>
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.5"
                                        value={edicionHoras}
                                        onChange={(e) => setEdicionHoras(e.target.value)}
                                        className="w-full p-2 bg-gray-50 border border-gray-300 rounded-none outline-none font-bold text-right"
                                        placeholder="0"
                                      />
                                    </div>
                                  )}
                                </div>
                                {editJornadaData && (() => {
                                  const horasEdit = calcularHorasJornada({
                                    inicio: editJornadaData.inicioHora ? { hora: editJornadaData.inicioHora } : null,
                                    pausas: editJornadaData.eventos,
                                    fin: editJornadaData.finHora ? { hora: editJornadaData.finHora } : null
                                  });
                                  return (
                                    <p className="text-[11px] text-teal-700 font-semibold mt-1.5">
                                      ⏱️ Horas calculadas de la jornada: {horasEdit} hs (no se cargan a mano)
                                    </p>
                                  );
                                })()}
                              </div>

                              {editJornadaData ? (
                                <div>
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-emerald-600 mb-1.5">Eventos de la jornada</p>
                                  <div className="space-y-2">
                                    <div className="bg-emerald-50/60 border border-emerald-200 p-2 space-y-1.5">
                                      <p className="text-[10px] font-bold text-emerald-800">▶️ Inicio de jornada</p>
                                      <div className="grid grid-cols-2 gap-2 text-xs">
                                        <div>
                                          <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🕐 Hora</label>
                                          <input
                                            type="time"
                                            value={editJornadaData.inicioHora}
                                            onChange={(e) => actualizarCampoEditJornada('inicioHora', e.target.value)}
                                            className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-center"
                                          />
                                        </div>
                                        <div>
                                          <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🛣️ Kilometraje</label>
                                          <input
                                            type="number"
                                            inputMode="numeric"
                                            value={editJornadaData.inicioKm}
                                            onChange={(e) => actualizarCampoEditJornada('inicioKm', e.target.value)}
                                            className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-right"
                                            placeholder="0"
                                          />
                                        </div>
                                      </div>
                                    </div>

                                    {editJornadaData.eventos.map((ev, idx) => (
                                      <div key={idx} className="bg-gray-50 border border-gray-200 p-2 space-y-1.5">
                                        <div className="flex justify-between items-center">
                                          <p className={`text-[10px] font-bold ${ev.tipo === 'pausa' ? 'text-amber-700' : 'text-green-700'}`}>
                                            {ev.tipo === 'pausa' ? '⏸️ Pausa' : '▶️ Reanudación'}
                                          </p>
                                          <button
                                            onClick={() => quitarEventoEdicion(idx)}
                                            className="text-red-400 hover:text-red-600 text-xs font-bold px-1"
                                            title="Quitar este registro"
                                          >
                                            ✕
                                          </button>
                                        </div>
                                        <div className="grid grid-cols-2 gap-2 text-xs">
                                          <div>
                                            <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🕐 Hora</label>
                                            <input
                                              type="time"
                                              value={ev.hora || ''}
                                              onChange={(e) => actualizarEventoEdicion(idx, 'hora', e.target.value)}
                                              className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-center"
                                            />
                                          </div>
                                          <div>
                                            <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🛣️ Kilometraje</label>
                                            <input
                                              type="number"
                                              inputMode="numeric"
                                              value={ev.km !== undefined && ev.km !== null ? ev.km : ''}
                                              onChange={(e) => actualizarEventoEdicion(idx, 'km', e.target.value)}
                                              className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-right"
                                              placeholder="0"
                                            />
                                          </div>
                                        </div>
                                        {ev.tipo === 'pausa' && (
                                          <div className="grid grid-cols-2 gap-2 text-xs">
                                            <div>
                                              <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🚗 Uber acumulado ($)</label>
                                              <input
                                                type="number"
                                                inputMode="numeric"
                                                value={ev.uber !== undefined && ev.uber !== null ? ev.uber : ''}
                                                onChange={(e) => actualizarEventoEdicion(idx, 'uber', e.target.value)}
                                                className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-right"
                                                placeholder="0"
                                              />
                                            </div>
                                            <div>
                                              <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🚕 DiDi acumulado ($)</label>
                                              <input
                                                type="number"
                                                inputMode="numeric"
                                                value={ev.didi !== undefined && ev.didi !== null ? ev.didi : ''}
                                                onChange={(e) => actualizarEventoEdicion(idx, 'didi', e.target.value)}
                                                className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-right"
                                                placeholder="0"
                                              />
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    ))}

                                    <div className="bg-blue-50/60 border border-blue-200 p-2 space-y-1.5">
                                      <p className="text-[10px] font-bold text-blue-800">🏁 Finalización</p>
                                      <div className="grid grid-cols-2 gap-2 text-xs">
                                        <div>
                                          <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🕐 Hora</label>
                                          <input
                                            type="time"
                                            value={editJornadaData.finHora}
                                            onChange={(e) => actualizarCampoEditJornada('finHora', e.target.value)}
                                            className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-center"
                                          />
                                        </div>
                                        <div>
                                          <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🛣️ Kilometraje</label>
                                          <input
                                            type="number"
                                            inputMode="numeric"
                                            value={editJornadaData.finKm}
                                            onChange={(e) => actualizarCampoEditJornada('finKm', e.target.value)}
                                            className="w-full p-1.5 bg-white border border-gray-300 rounded-none outline-none font-bold text-right"
                                            placeholder="0"
                                          />
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                </div>
                              ) : (
                                <div>
                                  <p className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-1.5">Registro parcial del día</p>
                                  <div className="grid grid-cols-3 gap-2 text-xs">
                                    <div>
                                      <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🚗 Parcial Uber ($)</label>
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        value={edicionUberParcial}
                                        onChange={(e) => setEdicionUberParcial(e.target.value)}
                                        className="w-full p-2 bg-amber-50 border border-amber-200 rounded-none outline-none font-bold text-right"
                                        placeholder="0"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] text-gray-500 font-bold mb-0.5">🚕 Parcial DiDi ($)</label>
                                      <input
                                        type="number"
                                        inputMode="numeric"
                                        value={edicionDidiParcial}
                                        onChange={(e) => setEdicionDidiParcial(e.target.value)}
                                        className="w-full p-2 bg-amber-50 border border-amber-200 rounded-none outline-none font-bold text-right"
                                        placeholder="0"
                                      />
                                    </div>
                                    <div>
                                      <label className="block text-[10px] text-gray-500 font-bold mb-0.5">⏱️ Parcial Horas</label>
                                      <input
                                        type="number"
                                        inputMode="decimal"
                                        step="0.5"
                                        value={edicionHorasParcial}
                                        onChange={(e) => setEdicionHorasParcial(e.target.value)}
                                        className="w-full p-2 bg-amber-50 border border-amber-200 rounded-none outline-none font-bold text-right"
                                        placeholder="0"
                                      />
                                    </div>
                                  </div>
                                </div>
                              )}
                            </div>
                          ) : (
                            <>
                              <div>
                                <p className={`font-semibold text-sm capitalize ${d.dia === fecha.diaHoy ? 'text-blue-700' : 'text-slate-700'}`}>
                                  {obtenerNombreDia(d.dia, fecha.año, fecha.mesIndex)}
                                </p>
                                <p className="text-xs text-gray-500 mt-0.5">
                                  Meta: {formatearDinero(d.esperado)}
                                </p>
                                {(d.uber !== null || d.didi !== null || d.horas !== null) && (
                                  <div className="text-[11px] text-gray-600 mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5">
                                    {d.uber && <span>🚗 Uber: <strong>{formatearDinero(d.uber)}</strong></span>}
                                    {d.didi && <span>🚕 DiDi: <strong>{formatearDinero(d.didi)}</strong></span>}
                                    {d.horas && <span>⏱️ <strong>{d.horas} hs</strong> {d.real > 0 ? `(${formatearDinero(Math.round(d.real / d.horas))}/h)` : ''}</span>}
                                  </div>
                                )}
                              </div>
                              <div className="text-right flex items-center gap-3">
                                {d.real !== null ? (
                                  <div className="flex items-center gap-2">
                                    {esDiaNoTrabajado(d) ? (
                                      d.esFranco ? (
                                        <span className="text-[11px] font-bold uppercase tracking-wide text-emerald-700 bg-emerald-50 border border-emerald-200 px-2 py-1 rounded-none" title="Día franco asignado">
                                          🎮 Franco
                                        </span>
                                      ) : (
                                        <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500 bg-gray-100 border border-gray-200 px-2 py-1 rounded-none" title="Día cerrado sin ingresos ($0)">
                                          Día no trabajado
                                        </span>
                                      )
                                    ) : (
                                      <span className={`font-bold text-lg ${d.real >= d.esperado ? 'text-green-600' : 'text-red-500'}`}>
                                        {formatearDinero(d.real)}
                                      </span>
                                    )}
                                    <button 
                                      onClick={() => iniciarEdicion(d)} 
                                      className="text-slate-400 hover:text-blue-600 p-1.5 transition-colors focus:outline-none"
                                      title="Editar ingreso"
                                    >
                                      <svg className="w-4 h-4 fill-none stroke-current stroke-[2]" viewBox="0 0 24 24" strokeLinecap="round" strokeLinejoin="round">
                                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                                      </svg>
                                    </button>
                                  </div>
                                ) : d.dia < fecha.diaHoy ? (
                                  <button 
                                    onClick={() => iniciarEdicion(d)} 
                                    className="text-gray-400 hover:text-blue-600 text-xs font-medium transition-colors focus:outline-none"
                                    title="Cerrar día"
                                  >
                                    Sin cargar ✏️
                                  </button>
                                ) : (
                                  <span className="text-gray-400 text-xs font-medium">
                                    {d.dia === fecha.diaHoy ? 'Hoy' : 'Pendiente'}
                                  </span>
                                )}

                                <button 
                                  onClick={() => setDiaModalSeleccionado(d.dia)}
                                  className="w-10 h-10 bg-white border border-gray-200 rounded-none flex items-center justify-center text-xl shadow-2xs hover:bg-sky-50 hover:border-sky-200 transition-all active:scale-95 cursor-pointer"
                                  title="Ver detalle del clima"
                                >
                                  {iconoClima}
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* --- VISTA 2: GRÁFICOS CON COMPARADOR DE MESES --- */}
        {seccion === 'trabajo' && vistaActual === 'graficos' && (
          <div className={tabAnimClass}>
          <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4 mb-6">
            <h3 className="font-bold text-lg mb-1 text-slate-800">Progreso hacia la Meta</h3>
            <p className="text-sm text-gray-500 mb-4">Comparación entre lo ideal, lo real y meses anteriores.</p>
            
            {Object.keys(mesesHistoricos).filter(id => id !== fecha.idMes).length > 0 && (
              <div className="mb-4 bg-gray-50 p-3 rounded-none border border-gray-100">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400 mb-2">Sumar curvas de meses anteriores:</p>
                <div className="flex flex-wrap gap-2">
                  {Object.keys(mesesHistoricos)
                    .filter(id => id !== fecha.idMes)
                    .map((idMes) => {
                      const activo = mesesComparados.includes(idMes);
                      return (
                        <button
                          key={idMes}
                          onClick={() => toggleMesComparacion(idMes)}
                          className={`text-xs px-3 py-1.5 rounded-none font-bold transition-all ${
                            activo 
                              ? 'bg-blue-600 text-white shadow-sm' 
                              : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-100'
                          }`}
                        >
                          {obtenerNombreMesLegible(idMes)} {activo && '✓'}
                        </button>
                      );
                    })}
                </div>
              </div>
            )}

            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={datosGrafico} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis 
                    dataKey="dia" 
                    tick={{fontSize: 12, fill: '#6b7280'}} 
                    tickMargin={10} 
                    axisLine={false} 
                    tickLine={false}
                  />
                  <YAxis hide={true} domain={[0, 'dataMax']} />
                  <Tooltip content={<ProgresoTooltip />} />
                  <Legend verticalAlign="top" height={36} iconType="circle" />
                  <Line 
                    type="monotone" 
                    name="Ruta Ideal"
                    dataKey="Esperado" 
                    stroke="#94a3b8" 
                    strokeWidth={2} 
                    dot={false}
                    strokeDasharray="5 5"
                  />
                  <Line 
                    type="monotone" 
                    name="Real Actual"
                    dataKey="Real" 
                    stroke="#2563eb" 
                    strokeWidth={3}
                    dot={{ r: 3, fill: '#2563eb', strokeWidth: 0 }}
                    activeDot={{ r: 6 }}
                  />
                  {mesesComparados.map((idMes, idx) => (
                    <Line 
                      key={idMes}
                      type="monotone" 
                      name={obtenerNombreMesLegible(idMes)}
                      dataKey={idMes} 
                      stroke={coloresComparacion[idx % coloresComparacion.length]} 
                      strokeWidth={2}
                      dot={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {(() => {
              const ultimoCerrado = [...dias].reverse().find(d => d.real !== null && Number(d.real) > 0);
              if (!ultimoCerrado) return null;
              return (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-gray-400 mb-2">Último día cerrado</p>
                  <div className="grid grid-cols-3 gap-3">
                    <div className="text-center">
                      <p className="text-[10px] text-gray-500">Día {ultimoCerrado.dia}</p>
                      <p className={`text-sm font-bold ${Number(ultimoCerrado.real) >= ultimoCerrado.esperado ? 'text-green-600' : 'text-red-500'}`}>
                        {formatearDinero(ultimoCerrado.real)}
                      </p>
                    </div>
                    <div className="text-center border-x border-gray-100">
                      <p className="text-[10px] text-gray-500">Uber</p>
                      <p className="text-sm font-bold text-slate-700">
                        {ultimoCerrado.uber ? formatearDinero(ultimoCerrado.uber) : '—'}
                      </p>
                    </div>
                    <div className="text-center">
                      <p className="text-[10px] text-gray-500">DiDi</p>
                      <p className="text-sm font-bold text-slate-700">
                        {ultimoCerrado.didi ? formatearDinero(ultimoCerrado.didi) : '—'}
                      </p>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>

          <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4 mb-6">
            <div className="flex items-center justify-between mb-1">
              <h3 className="font-bold text-lg text-slate-800">
                {modoGraficoGanancia === 'hora' ? 'Dinero por Hora' : 'Ganancia por Día'}
              </h3>
              <div className="flex bg-gray-100 rounded-none p-0.5">
                <button
                  onClick={() => setModoGraficoGanancia('hora')}
                  className={`text-[11px] font-bold px-3 py-1.5 rounded-none transition-all ${modoGraficoGanancia === 'hora' ? 'bg-teal-500 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  $/hora
                </button>
                <button
                  onClick={() => setModoGraficoGanancia('dia')}
                  className={`text-[11px] font-bold px-3 py-1.5 rounded-none transition-all ${modoGraficoGanancia === 'dia' ? 'bg-teal-500 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}
                >
                  $/día
                </button>
              </div>
            </div>
            <p className="text-sm text-gray-500 mb-4">
              {modoGraficoGanancia === 'hora'
                ? 'Cuánto ganaste por hora trabajada cada día. Pasá el cursor sobre una barra para ver el detalle.'
                : 'Cuánto facturaste cada día trabajado. Pasá el cursor sobre una barra para ver el detalle.'}
            </p>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-500 font-medium">Mostrando días {zoomInicio + 1} a {Math.min(zoomInicio + zoomDias, datosDineroHora.length)} de {datosDineroHora.length}</span>
              <div className="flex gap-1.5">
                <button onClick={() => setZoomDias(Math.min(zoomDias + 5, 31))} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors" title="Alejar (ver más días)">−</button>
                <button onClick={() => setZoomDias(Math.max(zoomDias - 5, 7))} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors" title="Acercar (ver menos días)">+</button>
                <button onClick={() => setZoomInicio(Math.max(zoomInicio - 5, 0))} disabled={zoomInicio === 0} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors disabled:opacity-30" title="Anterior">◀</button>
                <button onClick={() => setZoomInicio(Math.min(zoomInicio + 5, datosDineroHora.length - zoomDias))} disabled={zoomInicio >= datosDineroHora.length - zoomDias} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors disabled:opacity-30" title="Siguiente">▶</button>
                <button onClick={() => { setZoomDias(31); setZoomInicio(0); }} className="w-9 h-9 bg-blue-50 hover:bg-blue-100 rounded-none font-bold text-blue-600 text-xs transition-colors" title="Ver todo">Todo</button>
              </div>
            </div>
            <div className="h-96 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={datosDineroHora.slice(zoomInicio, zoomInicio + zoomDias)} margin={{ top: 20, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis dataKey="dia" tick={{fontSize: 12, fill: '#6b7280'}} tickMargin={10} axisLine={false} tickLine={false} />
                  <YAxis tick={{fontSize: 12, fill: '#6b7280'}} tickMargin={10} axisLine={false} tickLine={false} domain={[0, 'dataMax']} />
                  <Tooltip content={<DineroHoraTooltip />} cursor={{ fill: 'rgba(20, 184, 166, 0.1)' }} />
                  {modoGraficoGanancia === 'hora' ? (
                    <Bar dataKey="dineroHora" name="Dinero/Hora" fill="#14b8a6" radius={[4, 4, 0, 0]} minPointSize={2}>
                      <LabelList dataKey="dineroHora" position="top" style={{ fontSize: 8, fill: '#6b7280' }} />
                    </Bar>
                  ) : (
                    <Bar dataKey="total" name="Ganancia/Día" fill="#8b5cf6" radius={[4, 4, 0, 0]} minPointSize={2}>
                      <LabelList dataKey="total" position="top" style={{ fontSize: 8, fill: '#6b7280' }} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-center gap-2">
              <span className="text-xs text-gray-500">Promedio:</span>
              <span className={`text-sm font-bold ${modoGraficoGanancia === 'hora' ? 'text-teal-600' : 'text-purple-600'}`}>
                {modoGraficoGanancia === 'hora'
                  ? `${formatearDinero(promedioGananciaHora)}/hs`
                  : `${formatearDinero(promedioGananciaDia)}/día`}
              </span>
            </div>
          </div>

          <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4 mb-6">
            <h3 className="font-bold text-lg mb-1 text-slate-800">Horas Trabajadas por Día</h3>
            <p className="text-sm text-gray-500 mb-4">Cantidad de horas trabajadas cada día. Pasá el cursor sobre una barra para ver el total facturado.</p>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-500 font-medium">Mostrando días {zoomInicio + 1} a {Math.min(zoomInicio + zoomDias, datosHoras.length)} de {datosHoras.length}</span>
              <div className="flex gap-1.5">
                <button onClick={() => setZoomDias(Math.min(zoomDias + 5, 31))} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors" title="Alejar (ver más días)">−</button>
                <button onClick={() => setZoomDias(Math.max(zoomDias - 5, 7))} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors" title="Acercar (ver menos días)">+</button>
                <button onClick={() => setZoomInicio(Math.max(zoomInicio - 5, 0))} disabled={zoomInicio === 0} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors disabled:opacity-30" title="Anterior">◀</button>
                <button onClick={() => setZoomInicio(Math.min(zoomInicio + 5, datosHoras.length - zoomDias))} disabled={zoomInicio >= datosHoras.length - zoomDias} className="w-9 h-9 bg-gray-100 hover:bg-gray-200 rounded-none font-bold text-gray-700 text-lg transition-colors disabled:opacity-30" title="Siguiente">▶</button>
                <button onClick={() => { setZoomDias(31); setZoomInicio(0); }} className="w-9 h-9 bg-blue-50 hover:bg-blue-100 rounded-none font-bold text-blue-600 text-xs transition-colors" title="Ver todo">Todo</button>
              </div>
            </div>
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={datosHoras.slice(zoomInicio, zoomInicio + zoomDias)} margin={{ top: 20, right: 10, left: 10, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e5e7eb" />
                  <XAxis dataKey="dia" tick={{fontSize: 12, fill: '#6b7280'}} tickMargin={10} axisLine={false} tickLine={false} />
                  <YAxis tick={{fontSize: 12, fill: '#6b7280'}} tickMargin={10} axisLine={false} tickLine={false} allowDecimals={false} domain={[0, 'dataMax']} />
                  <Tooltip content={<HorasTooltip />} cursor={{ fill: 'rgba(139, 92, 246, 0.1)' }} />
                  <Bar dataKey="horas" name="Horas" fill="#8b5cf6" radius={[4, 4, 0, 0]} minPointSize={2}>
                    <LabelList dataKey="horas" position="top" style={{ fontSize: 9, fill: '#6b7280' }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-4 pt-3 border-t border-gray-100 space-y-1.5">
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500 font-medium">Horas totales trabajadas</span>
                <span className="text-lg font-bold text-purple-700">⏱️ {diasConHoras.reduce((acc, d) => acc + Number(d.horas), 0).toFixed(1)} hs</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-gray-500 font-medium">Promedio por día</span>
                <span className="text-sm font-semibold text-purple-500">{promedioHoras} hs</span>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* --- VISTA 3: HISTORIAL DE MESES (LIMPIO Y ORDENADO) --- */}
        {seccion === 'trabajo' && vistaActual === 'historial' && (
          <div className={`space-y-4 ${tabAnimClass}`}>
            {mesSeleccionadoDetalle === null ? (
              <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
                <h3 className="font-bold text-lg mb-1 text-slate-800">Historial de Meses</h3>
                <p className="text-xs text-gray-500 mb-4">Hacé clic en cualquier mes para ver el detalle de cada día y su acumulado.</p>

                <div className="space-y-3">
                  {Object.keys(mesesHistoricos).sort().reverse().map((idMes) => {
                    const mesData = mesesHistoricos[idMes];
                    const totalFacturado = mesData.dias ? mesData.dias.reduce((acc, d) => acc + (d.real || 0), 0) : 0;
                    const metaMes = mesData.metaTotal || 0;
                    const cumplido = totalFacturado >= metaMes;
                    const esActual = idMes === fecha.idMes;
                    const nombreMesLegible = obtenerNombreMesLegible(idMes);

                    return (
                      <div 
                        key={idMes} 
                        onClick={() => setMesSeleccionadoDetalle(idMes)}
                        className={`p-4 rounded-none border cursor-pointer hover:border-blue-400 transition-all ${esActual ? 'bg-blue-50/50 border-blue-200' : 'bg-white border-gray-200'}`}
                      >
                        <div className="flex justify-between items-center mb-2">
                          <span className="font-bold text-base text-slate-800 capitalize tracking-wide">
                            {nombreMesLegible} {esActual && '📍 [Actual]'}
                          </span>
                          <span className={`text-xs px-2.5 py-1 rounded-none font-bold ${cumplido ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700'}`}>
                            {cumplido ? 'Meta Cumplida 🎉' : 'En Proceso'}
                          </span>
                        </div>
                        <div className="flex justify-between items-center text-sm text-gray-600 border-t border-gray-100 pt-2 mt-2">
                          <span>Facturado: <strong className="text-slate-800">{formatearDinero(totalFacturado)}</strong></span>
                          <span className="text-blue-600 font-semibold">Ver detalle diario 🔍</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              /* DETALLE DEL MES SELECCIONADO DÍA A DÍA */
              <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
                <div className="flex justify-between items-center mb-4 border-b border-gray-100 pb-3">
                  <div>
                    <h3 className="font-bold text-lg text-slate-800 capitalize">Detalle de {obtenerNombreMesLegible(mesSeleccionadoDetalle)}</h3>
                    <p className="text-xs text-gray-400">Valores diarios y acumulados reales.</p>
                  </div>
                  <button 
                    onClick={() => setMesSeleccionadoDetalle(null)}
                    className="text-xs bg-gray-100 hover:bg-gray-200 font-bold px-3 py-1.5 rounded-none text-gray-600 transition-colors"
                  >
                    ← Volver
                  </button>
                </div>

                <div className="space-y-2.5 max-h-[500px] overflow-y-auto pr-1">
                  {mesesHistoricos[mesSeleccionadoDetalle]?.dias?.map((d, index, arr) => {
                    const acumuladoHastaAqui = arr.slice(0, index + 1).reduce((acc, curr) => acc + (curr.real || 0), 0);

                    return (
                      <div key={d.dia} className="p-3 rounded-none bg-gray-50 border border-gray-100 flex justify-between items-center text-sm">
                        <div>
                          <p className="font-bold text-slate-700">Día {d.dia}</p>
                          <p className="text-xs text-gray-400">Acumulado: <strong className="text-slate-600">{formatearDinero(acumuladoHastaAqui)}</strong></p>
                          {(d.uber !== null || d.didi !== null || d.horas !== null) && (
                            <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap gap-x-2">
                              {d.uber && <span>🚗 Uber: {formatearDinero(d.uber)}</span>}
                              {d.didi && <span>🚕 DiDi: {formatearDinero(d.didi)}</span>}
                              {d.horas && <span>⏱️ {d.horas} hs</span>}
                            </div>
                          )}
                        </div>
                        <div className="text-right">
                          {d.real !== null ? (
                            <span className="font-extrabold text-green-600 text-base">{formatearDinero(d.real)}</span>
                          ) : (
                            <span className="text-gray-400 text-xs italic">Sin carga</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* --- SECCIÓN: FINANZAS --- */}
        {seccion === 'finanzas' && subFinanzas === 'inicio' && !detalleFinanzas && (
          <div className="space-y-4">
            <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
              <div className="flex items-center justify-between mb-3">
                <button
                  onClick={() => cambiarMesFinanzas(-1)}
                  className="w-8 h-8 flex items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-100 rounded-none transition-colors text-lg leading-none"
                  title="Mes anterior"
                >
                  ‹
                </button>
                <span className="text-sm font-semibold text-slate-700 capitalize px-2 min-w-[110px] text-center flex-1">
                  {obtenerNombreMesLegible(idMesActivo)}
                </span>
                <button
                  onClick={() => cambiarMesFinanzas(1)}
                  className="w-8 h-8 flex items-center justify-center border border-gray-300 text-gray-600 hover:bg-gray-100 rounded-none transition-colors text-lg leading-none"
                  title="Mes siguiente"
                >
                  ›
                </button>
              </div>
              {idMesActivo !== fecha.idMes && (
                <button
                  onClick={() => setMesFinanzas(null)}
                  className="text-[11px] text-blue-600 font-semibold mb-2 uppercase tracking-wide hover:underline"
                >
                  ← Volver al mes actual
                </button>
              )}
              <div className="grid grid-cols-3 gap-2 text-center">
                <button
                  onClick={() => setDetalleFinanzas('ingreso')}
                  className="bg-emerald-50 p-3 hover:bg-emerald-100 transition-colors cursor-pointer active:bg-emerald-200"
                >
                  <span className="block text-xs text-gray-500 font-semibold uppercase">Ingresos</span>
                  <span className="block font-bold text-emerald-700 mt-1 text-sm">{formatearDinero(totalIngresosMes)}</span>
                  <span className="block text-[10px] text-emerald-600 mt-1">Ver ingresos →</span>
                </button>
                <button
                  onClick={() => setDetalleFinanzas('gasto')}
                  className="bg-red-50 p-3 hover:bg-red-100 transition-colors cursor-pointer active:bg-red-200"
                >
                  <span className="block text-xs text-gray-500 font-semibold uppercase">Gastos</span>
                  <span className="block font-bold text-red-600 mt-1 text-sm">{formatearDinero(totalGastosMes)}</span>
                  <span className="block text-[10px] text-red-600 mt-1">Ver gastos →</span>
                </button>
                <button
                  onClick={() => { setSubFinanzas('billeteras'); setDetalleFinanzas(null); setBilleteraSeleccionada(null); }}
                  className="bg-slate-50 p-3 hover:bg-slate-100 transition-colors cursor-pointer active:bg-slate-200"
                >
                  <span className="block text-xs text-gray-500 font-semibold uppercase">Disponible</span>
                  <span className={`block font-bold mt-1 text-sm ${totalDisponible >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{formatearDinero(totalDisponible)}</span>
                  <span className="block text-[10px] text-gray-500 mt-1">Ver billeteras →</span>
                </button>
              </div>

              <div className="mt-5 bg-slate-50 p-4 border border-gray-200">
                <div className="text-xs text-gray-500 font-semibold uppercase mb-2">Dinero en billeteras</div>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-gray-600">Total</span>
                    <span className="font-bold text-slate-800 text-sm">{formatearDinero(totalBilleteras)}</span>
                  </div>
                  <div className="flex justify-between items-center border-t border-gray-200 pt-2">
                    <span className="text-sm text-emerald-700 font-semibold">Disponible</span>
                    <span className={`font-bold text-sm ${totalDisponible >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{formatearDinero(totalDisponible)}</span>
                  </div>
                  <div className="flex justify-between items-center border-t border-gray-200 pt-2">
                    <span className="text-sm text-blue-700 font-semibold">Reservas</span>
                    <span className="font-bold text-sm text-blue-700">{formatearDinero(totalReservas)}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-3">
              <button
                onClick={() => abrirGasto()}
                className="w-full text-left bg-white rounded-none shadow-sm border border-red-200 p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
              >
                <span className="text-2xl">💸</span>
                <span>
                  <span className="block font-bold text-slate-800">Registrar gasto</span>
                  <span className="block text-sm text-gray-400">Agregá un egreso, con cuotas o no</span>
                </span>
              </button>
              <button
                onClick={() => abrirIngreso()}
                className="w-full text-left bg-white rounded-none shadow-sm border border-emerald-200 p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
              >
                <span className="text-2xl">📈</span>
                <span>
                  <span className="block font-bold text-slate-800">Registrar ingreso</span>
                  <span className="block text-sm text-gray-400">Agregá un ingreso a tu billetera</span>
                </span>
              </button>
            </div>
          </div>
        )}

        {/* --- FINANZAS: DETALLE DE INGRESOS O GASTOS --- */}
        {seccion === 'finanzas' && subFinanzas === 'inicio' && detalleFinanzas && (
          <div className="space-y-4">
            <button
              onClick={() => setDetalleFinanzas(null)}
              className="flex items-center gap-2 text-blue-600 font-semibold hover:underline uppercase text-xs tracking-wide"
            >
              ← Volver al resumen
            </button>
            <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
              <h3 className={`font-bold text-lg ${detalleFinanzas === 'ingreso' ? 'text-emerald-700' : 'text-red-600'}`}>
                {detalleFinanzas === 'ingreso' ? 'Ingresos' : 'Gastos'} · {obtenerNombreMesLegible(idMesActivo)}
              </h3>
              <div className="mt-3 text-sm text-gray-500 font-semibold">
                Total: {formatearDinero(detalleFinanzas === 'ingreso' ? totalIngresosMes : totalGastosMes)}
              </div>

              {(() => {
                const filtrados = movimientosMesActual.filter(m =>
                  detalleFinanzas === 'ingreso' ? m.tipo === 'ingreso' : m.tipo === 'gasto'
                );
                if (filtrados.length === 0) {
                  return (
                    <p className="text-sm text-gray-400 mt-3">
                      {detalleFinanzas === 'ingreso' ? 'No hay ingresos en este mes.' : 'No hay gastos en este mes.'}
                    </p>
                  );
                }
                return (
                  <div className="space-y-2 mt-3">
                    {filtrados.map(m => {
                      const cuotaNro = esRepetitivo(m) ? obtenerCuotaParaMes(m, idMesActivo) : null;
                      const valorMes = valorMovimientoEnMes(m, idMesActivo);
                      const esRepetido = esRepetitivo(m) && cuotaNro === null;
                      const descr = m.descripcion || m.observacion;
                      const fechaDia = m.fecha ? parseInt((m.fecha || '').slice(8, 10), 10) : null;
                      const mesMovRow = (m.fecha || '').slice(0, 7);
                      const esProyectado = esRepetitivo(m)
                        ? (idMesActivo > fecha.idMes) || (idMesActivo === fecha.idMes && fechaDia != null && fechaDia > fecha.diaHoy)
                        : (mesMovRow > fecha.idMes) || (mesMovRow === fecha.idMes && fechaDia != null && fechaDia > fecha.diaHoy);
                      let fechaVista = m.fecha;
                      if (esRepetitivo(m) && mesMovRow !== idMesActivo) {
                        const [vy, vm] = idMesActivo.split('-');
                        const diaOrig = (m.fecha || '').split('-')[2] ? parseInt((m.fecha || '').split('-')[2], 10) : 1;
                        const ultDia = new Date(Number(vy), Number(vm), 0).getDate();
                        fechaVista = `${idMesActivo}-${String(Math.min(diaOrig, ultDia)).padStart(2, '0')}`;
                      }
                      return (
                        <div key={m.ts} className="flex items-center justify-between border p-2.5 cursor-pointer active:bg-gray-50 border-gray-100" onClick={() => abrirEdicionMovimiento(m)}>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-lg">{m.tipo === 'gasto' ? '💸' : '📈'}</span>
                              <span className={`font-bold ${m.tipo === 'gasto' ? 'text-red-600' : 'text-emerald-700'}`}>{(m.categoria || '')}</span>
                              {m.subcategoria ? (
                                <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-none">{m.subcategoria}</span>
                              ) : null}
                              {cuotaNro && m.frecuencia !== 'fijo' && m.totalCuotas && (
                                <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-none">
                                  Cuota {cuotaNro}/{m.totalCuotas}
                                </span>
                              )}
                              {esProyectado && (
                                <span className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded-none">
                                  ⏳ Proyectado
                                </span>
                              )}
                              {m.realizada === false && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); alternarRealizada(m.ts); }}
                                  className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded-none cursor-pointer"
                                >
                                  ⏳ Pendiente · marcar realizada
                                </button>
                              )}
                            </div>
                            <div className="text-xs text-gray-400 mt-0.5">
                              {m.billetera} · {fechaVista}
                              {esRepetido ? ' · serie' : ''}
                              {esRepetitivo(m) ? ` · ${textoRepeticion(m)}` : ''}
                            </div>
                            {descr ? (
                              <div className="text-xs text-gray-500 mt-0.5 italic">"{descr}"</div>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2">
                            <span className={`font-bold ${m.tipo === 'gasto' ? 'text-red-600' : 'text-emerald-700'}`}>
                              {m.tipo === 'gasto' ? '-' : '+'}
                              {esRepetido ? formatearDinero(0) : formatearDinero(valorMes)}
                            </span>
                            <button
                              onClick={(e) => { e.stopPropagation(); abrirConfirmarBorrado(m, idMesActivo); }}
                              className="text-gray-300 hover:text-red-500 text-lg leading-none px-1"
                              aria-label="Eliminar"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* --- FINANZAS: BILLETERAS --- */}
        {seccion === 'finanzas' && subFinanzas === 'billeteras' && (
          <div className="space-y-4">
            {billeteraSeleccionada === null ? (
              <>
                <h3 className="font-bold text-lg text-slate-800">Billeteras</h3>
                <p className="text-xs text-gray-400">Cuentas bancarias donde entra y sale tu dinero.</p>

                <div className="flex gap-2">
                  <input
                    type="text"
                    value={nuevaBilleteraFinanzas}
                    onChange={(e) => setNuevaBilleteraFinanzas(e.target.value)}
                    placeholder="Nueva billetera"
                    className="flex-1 border border-gray-300 p-2 rounded-none text-slate-800"
                  />
                  <button
                    onClick={() => {
                      const v = nuevaBilleteraFinanzas.trim();
                      if (!v) return;
                      if (billeterasFinanzas.some(b => b.toLowerCase() === v.toLowerCase())) {
                        setNuevaBilleteraFinanzas('');
                        return;
                      }
                      const nuevas = [...billeterasFinanzas, v];
                      setBilleterasFinanzas(nuevas);
                      guardarConfigFinanzas(categoriasGasto, nuevas, subcategoriasGasto, undefined, undefined, categoriasIngreso, subcategoriasIngreso);
                      setNuevaBilleteraFinanzas('');
                    }}
                    className="bg-blue-600 text-white font-bold px-4 py-2 rounded-none hover:bg-blue-700 transition-colors"
                  >
                    +
                  </button>
                </div>

                {billeterasFinanzas.length === 0 ? (
                  <p className="text-sm text-gray-400">Todavía no tenés billeteras. Agregá una arriba.</p>
                ) : (
                  <div className="space-y-2">
                    {billeterasFinanzas.map(biel => {
                      const saldo = saldoBilletera(biel, movimientosFinanzas, fecha.idMes);
                      const esReserva = billeterasReserva.includes(biel);
                      return (
                        <button
                          key={biel}
                          onClick={() => setBilleteraSeleccionada(biel)}
                          className={`w-full flex items-center justify-between bg-white rounded-none shadow-sm border p-4 hover:bg-gray-50 transition-colors ${esReserva ? 'border-blue-300' : 'border-gray-200'}`}
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="text-2xl">💳</span>
                            <div>
                              <div className="font-bold text-slate-800 flex items-center gap-2">
                                {biel}
                                {esReserva && (
                                  <span className="text-[10px] bg-blue-600 text-white px-1.5 py-0.5 rounded-none uppercase font-semibold">Reserva</span>
                                )}
                              </div>
                              <div className="text-xs text-gray-400">Tocá para ver movimientos</div>
                            </div>
                          </div>
                          <div className="text-right">
                            <div className={`font-bold text-sm ${saldo >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                              {saldo >= 0 ? formatearDinero(saldo) : '-' + formatearDinero(Math.abs(saldo))}
                            </div>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                if (confirm(`¿Eliminar la billetera "${biel}"?`)) {
                                  eliminarBilleteraFinanzas(biel);
                                }
                              }}
                              className="text-gray-300 hover:text-red-500 text-lg leading-none mt-1"
                            >
                              ✕
                            </button>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </>
            ) : (
              <>
                <button
                  onClick={() => setBilleteraSeleccionada(null)}
                  className="text-sm text-gray-500"
                >
                  ← Volver a billeteras
                </button>
                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
                  <div className="flex items-center justify-between">
                    <h3 className="font-bold text-lg text-slate-800">{billeteraSeleccionada}</h3>
                    <button
                      onClick={() => alternarReservaBilletera(billeteraSeleccionada)}
                      className={`text-xs font-bold px-3 py-1.5 rounded-none transition-colors ${billeterasReserva.includes(billeteraSeleccionada) ? 'bg-blue-600 text-white' : 'bg-gray-100 text-slate-600'}`}
                    >
                      {billeterasReserva.includes(billeteraSeleccionada) ? '✔ Reserva' : 'Marcar como reserva'}
                    </button>
                  </div>
                  <div className={`font-bold text-sm mt-1 ${saldoBilletera(billeteraSeleccionada, movimientosFinanzas, fecha.idMes) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                    Dinero actual: {formatearDinero(saldoBilletera(billeteraSeleccionada, movimientosFinanzas, fecha.idMes))}
                  </div>
                  <div className="flex gap-2 mt-3">
                    <button
                      type="button"
                      onClick={abrirAjusteSaldo}
                      className="flex-1 text-xs font-bold px-3 py-2 rounded-none bg-gray-100 text-slate-600 hover:bg-gray-200 transition-colors"
                    >
                      💲 Ajustar saldo
                    </button>
                    <button
                      type="button"
                      onClick={abrirTransferencia}
                      className="flex-1 text-xs font-bold px-3 py-2 rounded-none bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                    >
                      🔄 Transferir
                    </button>
                  </div>
                  {ajusteSaldoAbierto && (
                    <div className="mt-3 bg-amber-50 border border-amber-200 p-3">
                      <div className="text-xs font-semibold text-slate-700 mb-2">
                        Ingresá el nuevo saldo para {billeteraSeleccionada}. La diferencia se registrará como ingreso o gasto.
                      </div>
                      <div className="text-[11px] text-gray-500 mb-2">
                        Saldo actual: {formatearDinero(saldoBilletera(billeteraSeleccionada, movimientosFinanzas, fecha.idMes))}
                      </div>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        value={ajusteSaldoValor}
                        onChange={(e) => setAjusteSaldoValor(e.target.value)}
                        placeholder="Nuevo saldo"
                        className="w-full border border-gray-300 p-2 rounded-none text-slate-800 mb-2"
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={confirmarAjusteSaldo}
                          className="flex-1 text-xs font-bold px-3 py-2 rounded-none bg-emerald-600 text-white hover:bg-emerald-700 transition-colors"
                        >
                          Confirmar
                        </button>
                        <button
                          type="button"
                          onClick={cerrarAjusteSaldo}
                          className="flex-1 text-xs font-bold px-3 py-2 rounded-none bg-gray-200 text-slate-600 hover:bg-gray-300 transition-colors"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="mt-3 pt-3 border-t border-gray-100">
                    <div className="flex items-center justify-between gap-2">
                      <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={billeterasDistribucion[billeteraSeleccionada] !== undefined}
                          onChange={(e) => setDistribucionActiva(billeteraSeleccionada, e.target.checked)}
                          className="w-4 h-4 accent-emerald-600"
                        />
                        Participar en distribución de ingresos
                      </label>
                      {billeterasDistribucion[billeteraSeleccionada] !== undefined && (
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min="0"
                            max="100"
                            value={billeterasDistribucion[billeteraSeleccionada] ?? ''}
                            onChange={(e) => actualizarPorcentajeDistribucion(billeteraSeleccionada, e.target.value)}
                            placeholder="%"
                            className="w-20 border border-gray-300 p-1.5 rounded-none text-slate-800 text-sm"
                          />
                          <span className="text-sm text-gray-500">%</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>

                <h4 className="font-bold text-slate-800 mb-2">Movimientos</h4>
                {(() => {
                  const movsBilletera = movimientosFinanzas.filter(m => {
                    if (m.tipo === 'transfer') {
                      return m.billetera === billeteraSeleccionada || m.billeteraDestino === billeteraSeleccionada;
                    }
                    return m.billetera === billeteraSeleccionada;
                  });
                  return movsBilletera.length === 0 ? (
                    <p className="text-sm text-gray-400">Todavía no hay movimientos en esta billetera.</p>
                  ) : (
                    <div className="space-y-2">
                      {movsBilletera
                        .slice()
                        .sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.ts || 0) - (a.ts || 0))
                        .map(m => {
                          const valorMes = valorMovimientoEnMes(m, fecha.idMes);
                          const esRepetido = esRepetitivo(m) && obtenerCuotaParaMes(m, fecha.idMes) === null;
                          const cuotaNroBiel = esRepetitivo(m) && m.frecuencia !== 'fijo' ? obtenerCuotaParaMes(m, fecha.idMes) : null;
                          const descr = m.descripcion || m.observacion;
                          const esSalida = m.tipo === 'transfer' && m.billetera === billeteraSeleccionada;
                          const esEntrada = m.tipo === 'transfer' && m.billeteraDestino === billeteraSeleccionada;
                          return (
                            <div key={m.ts} className="flex items-center justify-between border border-gray-100 p-2.5 cursor-pointer active:bg-gray-50" onClick={() => abrirEdicionMovimiento(m)}>
                              <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-lg">{m.tipo === 'gasto' ? '💸' : m.tipo === 'transfer' ? '🔄' : '📈'}</span>
                                  <span className={`font-bold ${m.tipo === 'gasto' ? 'text-red-600' : m.tipo === 'transfer' ? 'text-blue-600' : 'text-emerald-700'}`}>
                                    {m.tipo === 'transfer' ? `Transferencia ${esSalida ? 'saliente' : esEntrada ? 'entrante' : ''}` : (m.categoria || '')}
                                  </span>
                                  {m.subcategoria ? (
                                    <span className="text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded-none">{m.subcategoria}</span>
                                  ) : null}
                                  {cuotaNroBiel && m.totalCuotas && (
                                    <span className="text-[10px] bg-blue-50 text-blue-700 px-1.5 py-0.5 rounded-none">
                                      Cuota {cuotaNroBiel}/{m.totalCuotas}
                                    </span>
                                  )}
                                </div>
                                <div className="text-xs text-gray-400 mt-0.5">
                                  {m.tipo === 'transfer' ? `${m.billetera} → ${m.billeteraDestino}` : ''} {m.fecha}
                                  {esRepetido ? ' · serie' : ''}
                                  {esRepetitivo(m) ? ` · ${textoRepeticion(m)}` : ''}
                                </div>
                                {descr ? (
                                  <div className="text-xs text-gray-500 mt-0.5 italic">"{descr}"</div>
                                ) : null}
                              </div>
                              <div className="flex items-center gap-2">
                                <span className={`font-bold ${m.tipo === 'gasto' ? 'text-red-600' : m.tipo === 'transfer' ? (esEntrada ? 'text-emerald-700' : 'text-red-600') : 'text-emerald-700'}`}>
                                  {m.tipo === 'gasto' ? '-' : m.tipo === 'transfer' ? (esEntrada ? '+' : '-') : '+'}
                                  {esRepetido ? formatearDinero(0) : formatearDinero(valorMes)}
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); abrirConfirmarBorrado(m, fecha.idMes); }}
                                  className="text-gray-300 hover:text-red-500 text-lg leading-none px-1"
                                  aria-label="Eliminar"
                                >
                                  ✕
                                </button>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}

        {/* --- SECCIÓN: VEHÍCULO --- */}
        {seccion === 'vehiculo' && (
          <div className="space-y-4">
            {subVehiculo === 'inicio' && (
              <div className="grid grid-cols-1 gap-3">
                <button
                  onClick={abrirCombustible}
                  className="w-full text-left bg-white rounded-none shadow-sm border border-gray-200 p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="text-2xl">⛽</span>
                  <span className="font-bold text-slate-800">Cargar combustible</span>
                </button>
                <button
                  onClick={abrirReparacion}
                  className="w-full text-left bg-white rounded-none shadow-sm border border-gray-200 p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="text-2xl">🔧</span>
                  <span className="font-bold text-slate-800">Reparación</span>
                </button>
                <button
                  onClick={abrirMantenimiento}
                  className="w-full text-left bg-white rounded-none shadow-sm border border-gray-200 p-4 flex items-center gap-3 hover:bg-gray-50 transition-colors"
                >
                  <span className="text-2xl">🛠️</span>
                  <span className="font-bold text-slate-800">Mantenimiento</span>
                </button>
              </div>
            )}

            {subVehiculo === 'registros' && (
              registrosVehiculo.length > 0 ? (
                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
                  <h3 className="font-bold text-lg mb-3 text-slate-800">Registros</h3>
                  <div className="flex flex-wrap gap-4 mb-3">
                    <label className="flex items-center gap-1 text-sm text-slate-600 cursor-pointer">
                      <input type="checkbox" checked={filtroComb} onChange={(e) => setFiltroComb(e.target.checked)} className="w-4 h-4" /> Combustible
                    </label>
                    <label className="flex items-center gap-1 text-sm text-slate-600 cursor-pointer">
                      <input type="checkbox" checked={filtroRep} onChange={(e) => setFiltroRep(e.target.checked)} className="w-4 h-4" /> Reparación
                    </label>
                    <label className="flex items-center gap-1 text-sm text-slate-600 cursor-pointer">
                      <input type="checkbox" checked={filtroMant} onChange={(e) => setFiltroMant(e.target.checked)} className="w-4 h-4" /> Mantenimiento
                    </label>
                  </div>
                  <div className="space-y-2">
                    {[...registrosVehiculo]
                      .filter(r =>
                        (r.tipo === 'combustible' && filtroComb) ||
                        (r.tipo === 'reparacion' && filtroRep) ||
                        (r.tipo === 'mantenimiento' && filtroMant)
                      )
                      .sort((a, b) => {
                        if (a.tipo === 'mantenimiento' && b.tipo === 'mantenimiento') {
                          const fa = (Number(a.km) || 0) + (Number(a.cadaKm) || 0) - kmAuto;
                          const fb = (Number(b.km) || 0) + (Number(b.cadaKm) || 0) - kmAuto;
                          return fa - fb;
                        }
                        return (b.ts || 0) - (a.ts || 0);
                      })
                      .map((r, i) => (
                        <div key={r.ts || i} className={`flex items-center justify-between border-b border-gray-100 pb-2 last:border-0 ${r.hecho ? 'opacity-50' : ''}`}>
                          <div>
                            <div className="font-semibold text-slate-700 capitalize">
                              {r.tipo === 'combustible'
                                ? `⛽ Combustible (${r.combustible === 'gnc' ? 'GNC' : 'Nafta'})`
                                : r.tipo === 'reparacion'
                                  ? `🔧 Reparación: ${r.tipoReparacion}`
                                  : r.tipo === 'mantenimiento'
                                    ? `🛠️ Mantenimiento: ${r.tipoMantenimiento}${r.periodico ? ` (cada ${formatearKm(r.cadaKm)})` : ''}`
                                    : r.tipo}
                              {r.hecho && <span className="ml-2 text-xs text-emerald-600 font-semibold">✓ Hecho</span>}
                            </div>
                            <div className="text-xs text-gray-400">
                              {r.fecha.replace('T', ' ')} · 🛣️ {formatearKm(r.km)}
                            </div>
                          </div>
                          <div className="flex items-center gap-3">
                            {r.tipo === 'mantenimiento' && (
                              <label className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={!!r.hecho}
                                  onChange={() => toggleHechoMantenimiento(r.ts)}
                                  className="w-4 h-4"
                                />
                                Hecho
                              </label>
                            )}
                            <div className="font-bold text-slate-800">{formatearDinero(r.valor)}</div>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              ) : (
                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-8 text-center">
                  <p className="text-sm text-gray-400">Sin registros todavía.</p>
                </div>
              )
            )}

            {subVehiculo === 'graficos' && (
              <div className="space-y-4">
                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-4">
                  <h3 className="font-bold text-lg mb-1 text-slate-800">Km por día</h3>
                  <p className="text-sm text-gray-500 mb-4">Kilómetros recorridos en cada día (diferencia de odómetro).</p>
                  {datosGraficoKm.length > 0 ? (
                    <ResponsiveContainer width="100%" height={260}>
                      <BarChart data={datosGraficoKm} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" />
                        <XAxis dataKey="fecha" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} />
                        <Tooltip />
                        <Bar dataKey="km" fill="#10b981" />
                      </BarChart>
                    </ResponsiveContainer>
                  ) : (
                    <p className="text-sm text-gray-400">Sin datos de kilometraje.</p>
                  )}
                </div>
                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-8 text-center">
                  <span className="text-4xl">📊</span>
                  <h3 className="font-bold text-lg mt-3 text-slate-800">Gráfico 2</h3>
                  <p className="text-sm text-gray-400 mt-1">A desarrollar a futuro</p>
                </div>
                <div className="bg-white rounded-none shadow-sm border border-gray-200 p-8 text-center">
                  <span className="text-4xl">📈</span>
                  <h3 className="font-bold text-lg mt-3 text-slate-800">Gráfico 3</h3>
                  <p className="text-sm text-gray-400 mt-1">A desarrollar a futuro</p>
                </div>
              </div>
            )}
          </div>
        )}

      </div>

      {/* --- BARRA DE NAVEGACIÓN INFERIOR --- */}
      {seccion !== 'dashboard' && (
        <div 
          className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-0 py-3 flex items-center pb-safe z-40"
        >
        {seccion === 'trabajo' && (
          <>
            <div className="flex-1 flex justify-center">
              <button onClick={() => cambiarSeccion('dashboard')} className="flex flex-col items-center gap-1 transition-colors text-gray-400">
                <span className="text-2xl">🏠</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Home</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button onClick={() => cambiarVista('planificador')} className={`flex flex-col items-center gap-1 transition-colors ${vistaActual === 'planificador' ? 'text-blue-600' : 'text-gray-400'}`}>
                <span className="text-2xl">📝</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Carga</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button onClick={() => cambiarVista('graficos')} className={`flex flex-col items-center gap-1 transition-colors ${vistaActual === 'graficos' ? 'text-blue-600' : 'text-gray-400'}`}>
                <span className="text-2xl">📈</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Gráficos</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button onClick={() => cambiarVista('historial')} className={`flex flex-col items-center gap-1 transition-colors ${vistaActual === 'historial' ? 'text-blue-600' : 'text-gray-400'}`}>
                <span className="text-2xl">📊</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Historial</span>
              </button>
            </div>
          </>
        )}

        {seccion === 'finanzas' && (
          <>
            <div className="flex-1 flex justify-center">
              <button onClick={() => cambiarSeccion('dashboard')} className="flex flex-col items-center gap-1 transition-colors text-gray-400">
                <span className="text-2xl">🏠</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Home</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button
                onClick={() => { setSubFinanzas('inicio'); setDetalleFinanzas(null); }}
                className={`flex flex-col items-center gap-1 transition-colors ${subFinanzas === 'inicio' ? 'text-blue-600' : 'text-gray-400'}`}
              >
                <span className="text-2xl">📊</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Resumen</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button
                onClick={() => { setSubFinanzas('billeteras'); setDetalleFinanzas(null); setBilleteraSeleccionada(null); }}
                className={`flex flex-col items-center gap-1 transition-colors ${subFinanzas === 'billeteras' ? 'text-blue-600' : 'text-gray-400'}`}
              >
                <span className="text-2xl">💳</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Billeteras</span>
              </button>
            </div>
          </>
        )}

        {seccion === 'vehiculo' && (
          <>
            <div className="flex-1 flex justify-center">
              <button onClick={() => cambiarSeccion('dashboard')} className="flex flex-col items-center gap-1 transition-colors text-gray-400">
                <span className="text-2xl">🏠</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Home</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button onClick={() => setSubVehiculo('registros')} className={`flex flex-col items-center gap-1 transition-colors ${subVehiculo === 'registros' ? 'text-blue-600' : 'text-gray-400'}`}>
                <span className="text-2xl">📋</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Registros</span>
              </button>
            </div>
            <div className="flex-1 flex justify-center">
              <button onClick={() => setSubVehiculo('graficos')} className={`flex flex-col items-center gap-1 transition-colors ${subVehiculo === 'graficos' ? 'text-blue-600' : 'text-gray-400'}`}>
                <span className="text-2xl">📊</span>
                <span className="text-[10px] font-bold uppercase tracking-wider">Gráficos</span>
              </button>
            </div>
          </>
        )}
        </div>
      )}

      {/* --- MODAL INICIAR JORNADA --- */}
      {showIniciarModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-2">
              <h3 className="font-bold text-lg text-green-700">
                ▶️ Iniciar Jornada
              </h3>
              <button
                onClick={() => setShowIniciarModal(false)}
                className="w-8 h-8 bg-gray-100 rounded-none flex items-center justify-center text-gray-500 font-bold hover:bg-gray-200"
              >
                ✕
              </button>
            </div>
            <p className="text-xs text-gray-500 mb-4">
              La hora viene cargada con la hora actual. Si ya venías trabajando, editala antes de confirmar.
            </p>

            <div className="space-y-3.5">
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🕐 Hora de inicio</label>
                <input
                  type="time"
                  value={jornadaHoraInicio}
                  onChange={(e) => setJornadaHoraInicio(e.target.value)}
                  className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-green-500 outline-none transition-all"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🛣️ Kilometraje actual del auto</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={jornadaKmInicio}
                  onChange={(e) => setJornadaKmInicio(e.target.value)}
                  className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-green-500 outline-none transition-all"
                  placeholder="Ej: 125000"
                  autoFocus
                />
                <p className="text-[11px] text-gray-400 mt-1">Con este dato y el del cierre calculamos los kilómetros que recorrés trabajando.</p>
              </div>

              <button
                onClick={guardarIniciarJornada}
                className="w-full bg-green-600 text-white font-semibold text-lg py-4 rounded-none shadow-md transition-all active:scale-95 mt-2"
              >
                Iniciar Jornada
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL PAUSAR / RETOMAR JORNADA --- */}
      {showPausaRetomarModal && (() => {
        const esPausa = modoPausaRetomar === 'pausar';
        const diaObjModal = dias[diaSeleccionado - 1] || {};
        const horasHastaAhora = calcularHorasJornada(diaObjModal, pausaHora);
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
            <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
              <div className="flex justify-between items-center mb-2">
                <h3 className={`font-bold text-lg ${esPausa ? 'text-amber-600' : 'text-green-700'}`}>
                  {esPausa ? '⏸️ Pausar Jornada' : '▶️ Retomar Jornada'}
                </h3>
                <button
                  onClick={() => setShowPausaRetomarModal(false)}
                  className="w-8 h-8 bg-gray-100 rounded-none flex items-center justify-center text-gray-500 font-bold hover:bg-gray-200"
                >
                  ✕
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                {esPausa
                  ? 'Anotá lo que llevás facturado hasta ahora (montos acumulados del día) y el kilometraje actual.'
                  : 'Cargá la hora y el kilometraje en que volvés a la calle.'}
              </p>

              <div className="space-y-3.5">
                {esPausa && (
                  <>
                    <div>
                      <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🚗 Monto en Uber ($) — acumulado</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={pausaUber}
                        onChange={(e) => setPausaUber(e.target.value)}
                        className="w-full text-lg p-3 bg-amber-50 border border-amber-200 rounded-none focus:ring-2 focus:ring-amber-500 outline-none transition-all"
                        placeholder="Ej: 70000"
                        autoFocus
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🚕 Monto en DiDi ($) — acumulado</label>
                      <input
                        type="number"
                        inputMode="numeric"
                        value={pausaDidi}
                        onChange={(e) => setPausaDidi(e.target.value)}
                        className="w-full text-lg p-3 bg-amber-50 border border-amber-200 rounded-none focus:ring-2 focus:ring-amber-500 outline-none transition-all"
                        placeholder="Ej: 50000"
                      />
                    </div>
                  </>
                )}
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🕐 Hora</label>
                  <input
                    type="time"
                    value={pausaHora}
                    onChange={(e) => setPausaHora(e.target.value)}
                    className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🛣️ Kilometraje actual del auto</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={pausaKm}
                    onChange={(e) => setPausaKm(e.target.value)}
                    className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                    placeholder="Ej: 125230"
                  />
                </div>

                {((parseFloat(pausaUber) || 0) + (parseFloat(pausaDidi) || 0) > 0 || horasHastaAhora > 0) && (
                  <div className="bg-amber-50 border border-amber-200 p-3 rounded-none text-xs space-y-1">
                    <div className="flex justify-between font-bold text-slate-800">
                      <span>Subtotal acumulado hoy:</span>
                      <span className="text-green-600 text-sm">{formatearDinero((parseFloat(pausaUber) || 0) + (parseFloat(pausaDidi) || 0))}</span>
                    </div>
                    {horasHastaAhora > 0 && (
                      <div className="flex justify-between text-amber-800">
                        <span>⏱️ Horas trabajadas:</span>
                        <span className="font-bold">{horasHastaAhora} hs</span>
                      </div>
                    )}
                    {objetivoHoy > 0 && (parseFloat(pausaUber) || 0) + (parseFloat(pausaDidi) || 0) > 0 && (() => {
                      const subPausa = (parseFloat(pausaUber) || 0) + (parseFloat(pausaDidi) || 0);
                      const porcentajePausa = Math.min(100, Math.round((subPausa / objetivoHoy) * 100));
                      return (
                        <div className="mt-1.5 pt-1.5 border-t border-amber-300">
                          <div className="w-full bg-amber-200 rounded-full h-2">
                            <div
                              className="bg-amber-500 h-2 rounded-full transition-all duration-300"
                              style={{ width: `${porcentajePausa}%` }}
                            ></div>
                          </div>
                          <p className="text-[10px] text-amber-800 mt-1">
                            Llevás {formatearDinero(subPausa)} de {formatearDinero(objetivoHoy)} ({porcentajePausa}%)
                          </p>
                        </div>
                      );
                    })()}
                  </div>
                )}

                <button
                  onClick={guardarPausaRetomar}
                  className={`w-full text-white font-semibold text-lg py-4 rounded-none shadow-md transition-all active:scale-95 mt-2 ${esPausa ? 'bg-amber-500' : 'bg-green-600'}`}
                >
                  {esPausa ? 'Guardar Pausa' : 'Guardar Reanudación'}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* --- MODAL FINALIZAR JORNADA --- */}
      {showFinalizarModal && (() => {
        const diaObjF = dias[diaSeleccionado - 1] || {};
        const horasFinales = calcularHorasJornada(diaObjF, finHora);
        const totalFinal = (parseFloat(finUber) || 0) + (parseFloat(finDidi) || 0);
        const kmIniF = Number(diaObjF.inicio?.km);
        const kmFinF = parseFloat(finKm);
        const kmRecorridosF = (!isNaN(kmIniF) && kmIniF > 0 && !isNaN(kmFinF)) ? kmFinF - kmIniF : null;
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
            <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold text-lg text-blue-700">
                  🏁 Finalizar Jornada
                </h3>
                <button
                  onClick={() => setShowFinalizarModal(false)}
                  className="w-8 h-8 bg-gray-100 rounded-none flex items-center justify-center text-gray-500 font-bold hover:bg-gray-200"
                >
                  ✕
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                Cargá los totales finales del día. Las horas se calculan solas con los registros de tu jornada.
              </p>

              <div className="space-y-3.5">
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🚗 Monto final en Uber ($)</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={finUber}
                    onChange={(e) => setFinUber(e.target.value)}
                    className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                    placeholder="Ej: 120000"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🚕 Monto final en DiDi ($)</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={finDidi}
                    onChange={(e) => setFinDidi(e.target.value)}
                    className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-amber-500 outline-none transition-all"
                    placeholder="Ej: 80000"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🕐 Hora de finalización</label>
                  <input
                    type="time"
                    value={finHora}
                    onChange={(e) => setFinHora(e.target.value)}
                    className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                  />
                </div>
                <div>
                  <label className="block text-xs font-bold text-slate-600 uppercase tracking-wider mb-1">🛣️ Kilometraje actual del auto</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={finKm}
                    onChange={(e) => setFinKm(e.target.value)}
                    className="w-full text-lg p-3 bg-gray-50 border border-gray-200 rounded-none focus:ring-2 focus:ring-blue-500 outline-none transition-all"
                    placeholder="Ej: 125480"
                  />
                </div>

                {(totalFinal > 0 || horasFinales > 0) && (
                  <div className="bg-blue-50 border border-blue-200 p-3 rounded-none text-xs space-y-1">
                    <div className="flex justify-between font-bold text-slate-800">
                      <span>Total generado hoy:</span>
                      <span className="text-green-600 text-sm">{formatearDinero(totalFinal)}</span>
                    </div>
                    {horasFinales > 0 && (
                      <div className="flex justify-between text-blue-800">
                        <span>⏱️ Horas trabajadas:</span>
                        <span className="font-bold">{horasFinales} hs</span>
                      </div>
                    )}
                    {horasFinales > 0 && totalFinal > 0 && (
                      <div className="flex justify-between text-blue-800">
                        <span>Promedio por hora:</span>
                        <span className="font-bold">{formatearDinero(Math.round(totalFinal / horasFinales))}/hs</span>
                      </div>
                    )}
                    {kmRecorridosF !== null && kmRecorridosF >= 0 && (
                      <div className="flex justify-between text-blue-800">
                        <span>🛣️ Km recorridos hoy:</span>
                        <span className="font-bold">{formatearKm(kmRecorridosF)}</span>
                      </div>
                    )}
                    {objetivoHoy > 0 && totalFinal > 0 && (() => {
                      const porcentajeFin = Math.min(100, Math.round((totalFinal / objetivoHoy) * 100));
                      const superadoFin = totalFinal >= objetivoHoy;
                      return (
                        <div className="mt-1.5 pt-1.5 border-t border-blue-200">
                          <div className="flex justify-between items-center mb-1">
                            <span className={`text-xs font-bold ${superadoFin ? 'text-green-700' : 'text-blue-900'}`}>
                              {superadoFin ? '¡Meta superada! 🎉' : `Quedan ${formatearDinero(Math.max(0, objetivoHoy - totalFinal))}`}
                            </span>
                            <span className="text-xs font-semibold text-blue-700">{porcentajeFin}%</span>
                          </div>
                          <div className="w-full bg-blue-200 rounded-full h-2">
                            <div
                              className={`h-2 rounded-full transition-all duration-300 ${superadoFin ? 'bg-green-500' : 'bg-blue-500'}`}
                              style={{ width: `${porcentajeFin}%` }}
                            ></div>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}

                <button
                  onClick={guardarFinalizar}
                  className="w-full bg-blue-600 text-white font-semibold text-lg py-4 rounded-none shadow-md transition-all active:scale-95 mt-2"
                >
                  Confirmar y Finalizar Jornada
                </button>
              </div>
            </div>
          </div>
        );
      })()}


      {/* --- MODAL DETALLADO DEL CLIMA --- */}
      {diaModalSeleccionado !== null && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-900 capitalize">
                {obtenerNombreDia(diaModalSeleccionado, fecha.año, fecha.mesIndex)}
              </h3>
              <button 
                onClick={() => setDiaModalSeleccionado(null)}
                className="w-8 h-8 bg-gray-100 rounded-none flex items-center justify-center text-gray-500 font-bold hover:bg-gray-200"
              >
                ✕
              </button>
            </div>

            {climaPronostico[diaModalSeleccionado] ? (
              <div className="space-y-4">
                <div className="bg-sky-50 border border-sky-100 p-4 rounded-none flex items-center gap-4">
                  <span className="text-4xl">
                    {obtenerIconoClima(climaPronostico[diaModalSeleccionado].codigo, climaPronostico[diaModalSeleccionado].probLluvia)}
                  </span>
                  <div>
                    <p className="text-xs text-sky-600 font-semibold uppercase tracking-wider">Pronóstico General</p>
                    <p className="text-lg font-bold text-slate-800">
                      Mín {Math.round(climaPronostico[diaModalSeleccionado].tempMin)}°C / Máx {Math.round(climaPronostico[diaModalSeleccionado].tempMax)}°C
                    </p>
                    <p className="text-xs text-sky-700 mt-0.5">
                      Probabilidad de lluvia: <strong className="font-bold">{climaPronostico[diaModalSeleccionado].probLluvia}%</strong>
                    </p>
                  </div>
                </div>

                {climaPorHora[diaModalSeleccionado] ? (
                  <div>
                    <p className="text-xs text-slate-500 font-semibold uppercase tracking-wider mb-2">Pronóstico hora a hora</p>
                    <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
                      {climaPorHora[diaModalSeleccionado].map((h, i) => (
                        <div key={i} className="flex items-center justify-between bg-slate-50 border border-slate-100 p-2 rounded-none">
                          <div className="flex items-center gap-2">
                            <span className="text-xl">{obtenerIconoClima(climaPronostico[diaModalSeleccionado].codigo, h.probLluvia)}</span>
                            <span className="text-sm font-semibold text-slate-700">{h.hora}</span>
                          </div>
                          <div className="flex items-center gap-3 text-xs text-slate-600">
                            <span className="font-bold text-slate-800">{Math.round(h.temp)}°C</span>
                            <span className="text-sky-600">💧 {h.probLluvia}%</span>
                            {h.lluvia > 0 && <span className="text-blue-600">{h.lluvia} mm</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 mt-3">No hay datos hora a hora para este día.</p>
                )}
              </div>
            ) : (
              <p className="text-center text-gray-400 py-10">Cargando pronóstico...</p>
            )}
          </div>
        </div>
      )}

      {/* --- MODAL FRANCO POR EXCEDENTE --- */}
      {showFrancoModal && (() => {
        const offsetLunes = (new Date(fecha.año, fecha.mesIndex, 1).getDay() + 6) % 7;
        const celdas = [...Array(offsetLunes).fill(null), ...Array.from({ length: fecha.totalDias }, (_, i) => i + 1)];
        const diasSemana = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
        const excedenteModal = calcularExcedenteAcumulado(dias);
        const proximoModal = obtenerProximoDiaPendiente(dias);

        const esDiaHabilitado = (diaNum) => {
          if (!diaNum) return false;
          if (diaFrancoAsignado && diaFrancoAsignado.dia === diaNum) return true;
          if (diaNum < fecha.diaHoy) return false;
          const diaObj = dias[diaNum - 1];
          if (!diaObj || diaObj.real !== null) return false;
          if (diaNum === fecha.diaHoy && (diaObj.estadoJornada === 'activa' || diaObj.estadoJornada === 'pausada')) return false;
          return true;
        };

        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
            <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-bold text-lg text-emerald-700">
                  🎮 {diaFrancoAsignado ? 'Tu Día Franco' : 'Elegir Día Franco'}
                </h3>
                <button
                  onClick={() => setShowFrancoModal(false)}
                  className="w-8 h-8 bg-gray-100 rounded-none flex items-center justify-center text-gray-500 font-bold hover:bg-gray-200"
                >
                  ✕
                </button>
              </div>
              <p className="text-xs text-gray-500 mb-4">
                {diaFrancoAsignado
                  ? `Tenés un franco asignado para el ${obtenerNombreDia(diaFrancoAsignado.dia, fecha.año, fecha.mesIndex)}. Tocá otro día para moverlo o cancelalo.`
                  : 'Tocá un día del mes para asignarlo como franco. Ese día quedará en $0 y la meta se redistribuirá.'}
              </p>

              <div className="bg-emerald-50 border border-emerald-100 rounded-none p-3 mb-4 text-xs">
                <div className="flex justify-between">
                  <span className="text-slate-500">Excedente acumulado:</span>
                  <strong className={excedenteModal >= 0 ? 'text-emerald-700' : 'text-red-500'}>{formatearDinero(excedenteModal)}</strong>
                </div>
                <div className="flex justify-between mt-1">
                  <span className="text-slate-500">Meta del próximo día pendiente:</span>
                  <strong className="text-slate-700">{formatearDinero(proximoModal?.esperado || 0)}</strong>
                </div>
              </div>

              <div className="grid grid-cols-7 gap-1 mb-1">
                {diasSemana.map(d => (
                  <div key={d} className="text-center text-[10px] font-bold text-gray-400 uppercase py-1">{d}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1 mb-5">
                {celdas.map((diaNum, i) => {
                  if (!diaNum) return <div key={`vacio-${i}`} />;
                  const habilitado = esDiaHabilitado(diaNum);
                  const seleccionado = diaFrancoTemporal === diaNum;
                  const esFrancoActual = diaFrancoAsignado && diaFrancoAsignado.dia === diaNum;
                  const esHoy = diaNum === fecha.diaHoy;
                  let clases = 'aspect-square flex flex-col items-center justify-center rounded-none border text-xs font-semibold transition-colors ';
                  if (!habilitado) clases += 'bg-gray-50 text-gray-300 border-gray-100 cursor-not-allowed ';
                  else if (seleccionado) clases += 'bg-emerald-600 text-white border-emerald-600 shadow-sm scale-105 ';
                  else if (esFrancoActual) clases += 'bg-emerald-100 text-emerald-800 border-emerald-300 hover:bg-emerald-200 ';
                  else if (esHoy) clases += 'bg-white text-emerald-700 border-2 border-emerald-400 hover:bg-emerald-50 ';
                  else clases += 'bg-white text-slate-700 border-gray-200 hover:bg-emerald-50 hover:border-emerald-300 ';
                  return (
                    <button
                      key={diaNum}
                      disabled={!habilitado}
                      onClick={() => habilitado && setDiaFrancoTemporal(diaNum)}
                      className={clases}
                    >
                      {diaNum}
                      {esFrancoActual && <span className="text-[8px] leading-none mt-0.5">🎮</span>}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => {
                  if (diaFrancoTemporal === null) return alert('Seleccioná un día del calendario.');
                  guardarFechaFranco(diaFrancoTemporal);
                  setShowFrancoModal(false);
                  setDiaFrancoTemporal(null);
                }}
                disabled={diaFrancoTemporal === null}
                className={`w-full font-semibold text-base py-3.5 rounded-none shadow-md transition-all active:scale-95 ${diaFrancoTemporal !== null ? 'bg-emerald-600 text-white hover:bg-emerald-700' : 'bg-gray-200 text-gray-400 cursor-not-allowed'}`}
              >
                {diaFrancoAsignado ? 'Cambiar franco a este día' : 'Asignar franco'}
              </button>

              {diaFrancoAsignado && (
                <button
                  onClick={() => {
                    if (confirm(`¿Cancelar el franco del ${obtenerNombreDia(diaFrancoAsignado.dia, fecha.año, fecha.mesIndex)}? El día volverá a estar pendiente.`)) {
                      cancelarFranco();
                      setShowFrancoModal(false);
                      setDiaFrancoTemporal(null);
                    }
                  }}
                  className="w-full mt-2 font-semibold text-sm py-3 rounded-none border-2 border-red-200 text-red-600 hover:bg-red-50 transition-colors"
                >
                  ✕ Cancelar franco
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* --- MODAL CARGAR COMBUSTIBLE --- */}
      {showCombustibleModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">Cargar combustible</h3>
              <button onClick={() => setShowCombustibleModal(false)} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Fecha y hora</label>
                <input
                  type="datetime-local"
                  value={combFecha}
                  onChange={(e) => setCombFecha(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Valor de la carga</label>
                <div className="flex items-center border border-gray-300 rounded-none">
                  <span className="px-3 text-slate-500 font-bold">$</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={combValor}
                    onChange={(e) => setCombValor(e.target.value)}
                    className="flex-1 border-0 p-2 rounded-none text-slate-800 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Kilómetros del odómetro</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={combKm}
                  onChange={(e) => setCombKm(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <div className="flex gap-6">
                <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={combGnc}
                    onChange={(e) => { setCombGnc(e.target.checked); if (e.target.checked) setCombNafta(false); }}
                    className="w-4 h-4"
                  />
                  GNC
                </label>
                <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={combNafta}
                    onChange={(e) => { setCombNafta(e.target.checked); if (e.target.checked) setCombGnc(false); }}
                    className="w-4 h-4"
                  />
                  Nafta
                </label>
              </div>
              <button
                onClick={guardarCombustible}
                className="w-full bg-emerald-600 text-white font-bold py-3 rounded-none hover:bg-emerald-700 transition-colors"
              >
                GUARDAR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL REPARACIÓN --- */}
      {showReparacionModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">Reparación</h3>
              <button onClick={() => setShowReparacionModal(false)} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Fecha</label>
                <input
                  type="date"
                  value={repFecha}
                  onChange={(e) => setRepFecha(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Valor</label>
                <div className="flex items-center border border-gray-300 rounded-none">
                  <span className="px-3 text-slate-500 font-bold">$</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={repValor}
                    onChange={(e) => setRepValor(e.target.value)}
                    className="flex-1 border-0 p-2 rounded-none text-slate-800 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Kilómetros del odómetro</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={repKm}
                  onChange={(e) => setRepKm(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Tipo de reparación</label>
                <input
                  type="text"
                  value={repTipo}
                  onChange={(e) => setRepTipo(e.target.value)}
                  placeholder="Ej: Cambio de frenos, aceite, etc."
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <button
                onClick={guardarReparacion}
                className="w-full bg-emerald-600 text-white font-bold py-3 rounded-none hover:bg-emerald-700 transition-colors"
              >
                GUARDAR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL MANTENIMIENTO --- */}
      {showMantenimientoModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">Mantenimiento</h3>
              <button onClick={() => setShowMantenimientoModal(false)} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Fecha</label>
                <input
                  type="date"
                  value={mantFecha}
                  onChange={(e) => setMantFecha(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Valor</label>
                <div className="flex items-center border border-gray-300 rounded-none">
                  <span className="px-3 text-slate-500 font-bold">$</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={mantValor}
                    onChange={(e) => setMantValor(e.target.value)}
                    className="flex-1 border-0 p-2 rounded-none text-slate-800 outline-none"
                  />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Kilómetros del odómetro</label>
                <input
                  type="number"
                  inputMode="numeric"
                  value={mantKm}
                  onChange={(e) => setMantKm(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Tipo de mantenimiento</label>
                <input
                  type="text"
                  value={mantTipo}
                  onChange={(e) => setMantTipo(e.target.value)}
                  placeholder="Ej: Cambio de aceite, correa, etc."
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mantPeriodico}
                  onChange={(e) => setMantPeriodico(e.target.checked)}
                  className="w-4 h-4"
                />
                Periódico
              </label>
              {mantPeriodico && (
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">¿Cada cuántos kilómetros se realiza?</label>
                  <input
                    type="number"
                    inputMode="numeric"
                    value={mantCadaKm}
                    onChange={(e) => setMantCadaKm(e.target.value)}
                    className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                  />
                </div>
              )}
              <button
                onClick={guardarMantenimiento}
                className="w-full bg-emerald-600 text-white font-bold py-3 rounded-none hover:bg-emerald-700 transition-colors"
              >
                GUARDAR
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL GASTO --- */}
      {showGastoModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">{movEnEdicion ? 'Editar gasto' : 'Gastos'}</h3>
              <button onClick={() => { setShowGastoModal(false); setMovEnEdicion(null); }} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="space-y-4">
              {/* Fila 1: Descripción */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Descripción</label>
                <input
                  type="text"
                  value={gastoDescripcion}
                  onChange={(e) => setGastoDescripcion(e.target.value)}
                  placeholder="¿Qué es? (opcional)"
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              {/* Fila 2: Monto (clic abre la calculadora) */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Monto</label>
                <input
                  type="text"
                  readOnly
                  value={gastoMonto ? formatearDinero(parseFloat(gastoMonto)) : ''}
                  placeholder={gastoSeRepite && gastoMontoEs === 'total' ? 'Total a repartir' : 'Monto'}
                  onClick={() => abrirCalculadora('gasto')}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
                {gastoSeRepite && gastoMontoEs === 'total' && gastoTotalCuotas > 1 && gastoMonto ? (
                  <p className="text-xs text-gray-400 mt-1">
                    ≈ {formatearDinero(parseFloat(gastoMonto) / parseInt(gastoTotalCuotas, 10))} por cuota
                  </p>
                ) : null}
                {gastoSeRepite && gastoMontoEs === 'cuota' && gastoTotalCuotas > 1 && gastoMonto ? (
                  <p className="text-xs text-gray-400 mt-1">
                    Total: {formatearDinero(parseFloat(gastoMonto) * parseInt(gastoTotalCuotas, 10))}
                  </p>
                ) : null}
              </div>
              {/* Fila 3: Se repite */}
              <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={gastoSeRepite}
                  onChange={(e) => setGastoSeRepite(e.target.checked)}
                  className="w-4 h-4"
                />
                Se repite
              </label>
              {gastoSeRepite && (
                <div className="space-y-3 border-l-2 border-gray-200 pl-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">Frecuencia</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setGastoFrecuencia('mensual')}
                        className={`py-2 rounded-none text-sm font-bold ${gastoFrecuencia === 'mensual' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                      >
                        Mensual
                      </button>
                      <button
                        type="button"
                        onClick={() => setGastoFrecuencia('fijo')}
                        className={`py-2 rounded-none text-sm font-bold ${gastoFrecuencia === 'fijo' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                      >
                        Fijo
                      </button>
                    </div>
                  </div>
                  {gastoFrecuencia === 'fijo' ? (
                    <p className="text-xs text-gray-500">Se registrará este monto todos los meses hasta que lo elimines.</p>
                  ) : (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">¿Qué cuota es?</label>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          value={gastoCuota}
                          onChange={(e) => setGastoCuota(e.target.value)}
                          placeholder="Ej: 1"
                          className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">Total de cuotas</label>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          value={gastoTotalCuotas}
                          onChange={(e) => setGastoTotalCuotas(e.target.value)}
                          placeholder="Ej: 12"
                          className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">El monto de arriba es…</label>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setGastoMontoEs('total')}
                            className={`py-2 rounded-none text-sm font-bold ${gastoMontoEs === 'total' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                          >
                            Total
                          </button>
                          <button
                            type="button"
                            onClick={() => setGastoMontoEs('cuota')}
                            className={`py-2 rounded-none text-sm font-bold ${gastoMontoEs === 'cuota' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                          >
                            Valor de una cuota
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* Fila 4: Fecha */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Fecha</label>
                <input
                  type="date"
                  value={gastoFecha}
                  onChange={(e) => setGastoFecha(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              {/* Fila 5: Realizada */}
              <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={gastoRealizada}
                  onChange={(e) => setGastoRealizada(e.target.checked)}
                  className="w-4 h-4"
                />
                Realizada (ya se efectuó)
              </label>
              {/* Fila 6: Categoría */}
              <CampoAutocomplete
                label="Categoría"
                value={gastoCategoria}
                onChange={(v) => { setGastoCategoria(v); setGastoSubcategoria(''); }}
                opciones={categoriasGasto}
                placeholder="Elegí una categoría"
              />
              {/* Fila 7: Subcategoría (opcional, filtrada por categoría) */}
              {gastoCategoria && (
                <CampoAutocomplete
                  label="Subcategoría (opcional)"
                  value={gastoSubcategoria}
                  onChange={setGastoSubcategoria}
                  opciones={subcategoriasGasto[gastoCategoria] || []}
                  placeholder="Elegí una subcategoría"
                />
              )}
              {/* Fila 8: Billetera */}
              <CampoAutocomplete
                label="Billetera"
                value={gastoBilletera}
                onChange={setGastoBilletera}
                opciones={billeterasFinanzas}
                placeholder="Elegí la billetera"
              />
              {/* Fila 9: Guardar */}
              <button
                onClick={guardarGasto}
                className="w-full bg-red-600 text-white font-bold py-3 rounded-none hover:bg-red-700 transition-colors"
              >
                {movEnEdicion ? 'GUARDAR CAMBIOS' : 'GUARDAR'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL TRANSFERENCIA --- */}
      {transferenciaAbierta && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">🔄 Transferir saldo</h3>
              <button onClick={cerrarTransferencia} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Desde</label>
                <select
                  value={transferenciaOrigen || ''}
                  onChange={(e) => setTransferenciaOrigen(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                >
                  <option value="">Seleccioná una billetera</option>
                  {billeterasFinanzas.map(b => (
                    <option key={b} value={b}>{b}</option>
                  ))}
                </select>
                {transferenciaOrigen && (
                  <div className="text-xs text-gray-400 mt-1">
                    Saldo actual: {formatearDinero(saldoBilletera(transferenciaOrigen, movimientosFinanzas, fecha.idMes))}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Hacia</label>
                <select
                  value={transferenciaDestino}
                  onChange={(e) => setTransferenciaDestino(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                >
                  <option value="">Seleccioná una billetera</option>
                  {billeterasFinanzas
                    .filter(b => b !== transferenciaOrigen)
                    .map(b => (
                      <option key={b} value={b}>{b}</option>
                    ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Monto</label>
                <div className="flex items-center border border-gray-300 rounded-none">
                  <span className="px-3 text-slate-500 font-bold">$</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="0.01"
                    value={transferenciaMonto}
                    onChange={(e) => setTransferenciaMonto(e.target.value)}
                    placeholder="Monto a transferir"
                    className="flex-1 border-0 p-2 rounded-none text-slate-800 outline-none"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={cerrarTransferencia}
                  className="py-2 rounded-none bg-gray-200 text-slate-600 font-bold hover:bg-gray-300 transition-colors"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={confirmarTransferencia}
                  className="py-2 rounded-none bg-blue-600 text-white font-bold hover:bg-blue-700 transition-colors"
                >
                  Transferir
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL INGRESO --- */}
      {showIngresoModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">{movEnEdicion ? 'Editar ingreso' : 'Ingreso'}</h3>
              <button onClick={() => { setShowIngresoModal(false); setMovEnEdicion(null); }} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="space-y-4">
              {/* Fila 1: Descripción */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Descripción</label>
                <input
                  type="text"
                  value={ingresoDescripcion}
                  onChange={(e) => setIngresoDescripcion(e.target.value)}
                  placeholder="¿Qué es? (opcional)"
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              {/* Fila 2: Monto (clic abre la calculadora) */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Monto</label>
                <input
                  type="text"
                  readOnly
                  value={ingresoMonto ? formatearDinero(parseFloat(ingresoMonto)) : ''}
                  placeholder={ingresoSeRepite && ingresoMontoEs === 'total' ? 'Total a repartir' : 'Monto'}
                  onClick={() => abrirCalculadora('ingreso')}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
                {ingresoSeRepite && ingresoMontoEs === 'total' && ingresoTotalCuotas > 1 && ingresoMonto ? (
                  <p className="text-xs text-gray-400 mt-1">
                    ≈ {formatearDinero(parseFloat(ingresoMonto) / parseInt(ingresoTotalCuotas, 10))} por cuota
                  </p>
                ) : null}
                {ingresoSeRepite && ingresoMontoEs === 'cuota' && ingresoTotalCuotas > 1 && ingresoMonto ? (
                  <p className="text-xs text-gray-400 mt-1">
                    Total: {formatearDinero(parseFloat(ingresoMonto) * parseInt(ingresoTotalCuotas, 10))}
                  </p>
                ) : null}
              </div>
              {/* Fila 3: Se repite */}
              <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ingresoSeRepite}
                  onChange={(e) => setIngresoSeRepite(e.target.checked)}
                  className="w-4 h-4"
                />
                Se repite
              </label>
              {ingresoSeRepite && (
                <div className="space-y-3 border-l-2 border-gray-200 pl-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-600 mb-1">Frecuencia</label>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => setIngresoFrecuencia('mensual')}
                        className={`py-2 rounded-none text-sm font-bold ${ingresoFrecuencia === 'mensual' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                      >
                        Mensual
                      </button>
                      <button
                        type="button"
                        onClick={() => setIngresoFrecuencia('fijo')}
                        className={`py-2 rounded-none text-sm font-bold ${ingresoFrecuencia === 'fijo' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                      >
                        Fijo
                      </button>
                    </div>
                  </div>
                  {ingresoFrecuencia === 'fijo' ? (
                    <p className="text-xs text-gray-500">Se registrará este monto todos los meses hasta que lo elimines.</p>
                  ) : (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">¿Qué cuota es?</label>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          value={ingresoCuota}
                          onChange={(e) => setIngresoCuota(e.target.value)}
                          placeholder="Ej: 1"
                          className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">Total de cuotas</label>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="1"
                          value={ingresoTotalCuotas}
                          onChange={(e) => setIngresoTotalCuotas(e.target.value)}
                          placeholder="Ej: 12"
                          className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                        />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-600 mb-1">El monto de arriba es…</label>
                        <div className="grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            onClick={() => setIngresoMontoEs('total')}
                            className={`py-2 rounded-none text-sm font-bold ${ingresoMontoEs === 'total' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                          >
                            Total
                          </button>
                          <button
                            type="button"
                            onClick={() => setIngresoMontoEs('cuota')}
                            className={`py-2 rounded-none text-sm font-bold ${ingresoMontoEs === 'cuota' ? 'bg-slate-800 text-white' : 'bg-gray-100 text-slate-700'}`}
                          >
                            Valor de una cuota
                          </button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              {/* Fila 4: Fecha */}
              <div>
                <label className="block text-sm font-medium text-gray-600 mb-1">Fecha</label>
                <input
                  type="date"
                  value={ingresoFecha}
                  onChange={(e) => setIngresoFecha(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                />
              </div>
              {/* Fila 5: Realizada */}
              <label className="flex items-center gap-2 text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={ingresoRealizada}
                  onChange={(e) => setIngresoRealizada(e.target.checked)}
                  className="w-4 h-4"
                />
                Realizada (ya se efectuó)
              </label>
              {/* Fila 6: Categoría */}
              <CampoAutocomplete
                label="Categoría"
                value={ingresoCategoria}
                onChange={(v) => { setIngresoCategoria(v); setIngresoSubcategoria(''); }}
                opciones={categoriasIngreso}
                placeholder="Elegí una categoría"
              />
              {/* Fila 7: Subcategoría (opcional, filtrada por categoría) */}
              {ingresoCategoria && (
                <CampoAutocomplete
                  label="Subcategoría (opcional)"
                  value={ingresoSubcategoria}
                  onChange={setIngresoSubcategoria}
                  opciones={subcategoriasIngreso[ingresoCategoria] || []}
                  placeholder="Elegí una subcategoría"
                />
              )}
              {/* Fila 8: Billetera / Distribución */}
              <div>
                <label className="flex items-center gap-2 text-sm text-slate-700 mb-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ingresoDistribuir}
                    onChange={(e) => {
                      const on = e.target.checked;
                      setIngresoDistribuir(on);
                      if (on) prepararDistribucionIngreso();
                    }}
                    className="w-4 h-4 accent-emerald-600"
                  />
                  Distribuir entre varias billeteras
                </label>
                {!ingresoDistribuir ? (
                  <CampoAutocomplete
                    label="Billetera"
                    value={ingresoBilletera}
                    onChange={setIngresoBilletera}
                    opciones={billeterasFinanzas}
                    placeholder="Elegí la billetera"
                  />
                ) : (
                  <>
                    <label className="block text-sm font-medium text-gray-600 mb-1">Distribución a billeteras (%)</label>
                    {ingresoDistribucion.length === 0 && (
                      <p className="text-xs text-gray-500 mb-2">
                        No hay billeteras configuradas con porcentaje. Configuralas en cada tarjeta de billetera o agregalas abajo.
                      </p>
                    )}
                    {ingresoDistribucion.map((fila, idx) => (
                      <div key={idx} className="border border-gray-200 p-2 mb-2 rounded-none">
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <CampoAutocomplete
                              label={`Billetera ${idx + 1}`}
                              value={fila.billetera}
                              onChange={(v) => actualizarFilaIngreso(idx, 'billetera', v)}
                              opciones={billeterasFinanzas}
                              placeholder="Elegí la billetera"
                            />
                          </div>
                          <div className="w-20">
                            <label className="block text-sm font-medium text-gray-600 mb-1">%</label>
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={fila.porcentaje}
                              onChange={(e) => actualizarFilaIngreso(idx, 'porcentaje', e.target.value)}
                              placeholder="%"
                              className="w-full border border-gray-300 p-2 rounded-none text-slate-800"
                            />
                          </div>
                          <button
                            type="button"
                            onClick={() => quitarFilaIngreso(idx)}
                            disabled={ingresoDistribucion.length <= 1}
                            className="mt-5 text-red-500 text-xl px-1 disabled:opacity-30"
                            title="Quitar billetera"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={agregarFilaIngreso}
                      className="w-full border border-dashed border-emerald-400 text-emerald-600 font-medium py-2 rounded-none hover:bg-emerald-50 transition-colors"
                    >
                      ➕ Agregar otra billetera
                    </button>
                    {(() => {
                      const total = ingresoDistribucion
                        .filter(f => (f.billetera || '').trim() && f.porcentaje !== '' && f.porcentaje !== undefined && f.porcentaje !== null)
                        .reduce((acc, f) => acc + (parseFloat(f.porcentaje) || 0), 0);
                      const ok = Math.abs(total - 100) < 0.05;
                      return (
                        <div
                          className={`mt-2 px-3 py-2 text-sm font-medium border rounded-none ${
                            ok
                              ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
                              : 'text-red-700 bg-red-50 border-red-200'
                          }`}
                        >
                          Total distribuido: {total.toLocaleString('es-AR', { maximumFractionDigits: 2 })}% {ok ? '✓' : `(debe sumar 100%)`}
                        </div>
                      );
                    })()}
                  </>
                )}
              </div>
              {/* Fila 9: Guardar */}
              <button
                onClick={guardarIngreso}
                className="w-full bg-emerald-600 text-white font-bold py-3 rounded-none hover:bg-emerald-700 transition-colors"
              >
                {movEnEdicion ? 'GUARDAR CAMBIOS' : 'GUARDAR'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL CONFIRMACIÓN BORRADO --- */}
      {movConfirmarBorrar && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[60] flex items-center justify-center px-4">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">Eliminar movimiento</h3>
              <button onClick={cerrarConfirmarBorrado} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="mb-4">
              <p className={`font-bold ${movConfirmarBorrar.tipo === 'gasto' ? 'text-red-600' : movConfirmarBorrar.tipo === 'transfer' ? 'text-blue-600' : 'text-emerald-700'}`}>
                {movConfirmarBorrar.tipo === 'gasto' ? '-' : movConfirmarBorrar.tipo === 'transfer' ? '↔' : '+'}
                {formatearDinero(valorMovimientoEnMes(movConfirmarBorrar, idMesActivo))}
              </p>
              <p className="text-sm text-slate-700 mt-1">
                {movConfirmarBorrar.tipo === 'transfer'
                  ? `Transferencia de ${movConfirmarBorrar.billetera} a ${movConfirmarBorrar.billeteraDestino}`
                  : (movConfirmarBorrar.categoria || '')}
                {movConfirmarBorrar.tipo !== 'transfer' && movConfirmarBorrar.subcategoria ? ` · ${movConfirmarBorrar.subcategoria}` : ''}
              </p>
              {movConfirmarBorrar.descripcion ? (
                <p className="text-xs text-gray-500 italic mt-0.5">"{movConfirmarBorrar.descripcion}"</p>
              ) : null}
              {esRepetitivo(movConfirmarBorrar) ? (
                <p className="text-xs text-gray-400 mt-1">{textoRepeticion(movConfirmarBorrar)}</p>
              ) : null}
            </div>
            <p className="text-sm text-slate-600 mb-4">
              {esRepetitivo(movConfirmarBorrar)
                ? 'Este movimiento es una serie/cuotas. ¿Qué querés eliminar?'
                : '¿Estás seguro de que querés eliminar este movimiento? Esta acción no se puede deshacer.'}
            </p>
            <div className="space-y-2">
              {esRepetitivo(movConfirmarBorrar) ? (
                <>
                  <button
                    onClick={confirmarBorradoSerie}
                    className="w-full bg-red-600 text-white font-bold py-2.5 rounded-none hover:bg-red-700 transition-colors"
                  >
                    Eliminar toda la serie
                  </button>
                  <button
                    onClick={confirmarBorradoCuota}
                    className="w-full bg-amber-500 text-white font-bold py-2.5 rounded-none hover:bg-amber-600 transition-colors"
                  >
                    Eliminar solo esta cuota
                  </button>
                </>
              ) : (
                <button
                  onClick={confirmarBorradoSerie}
                  className="w-full bg-red-600 text-white font-bold py-2.5 rounded-none hover:bg-red-700 transition-colors"
                >
                  Eliminar
                </button>
              )}
              <button
                onClick={cerrarConfirmarBorrado}
                className="w-full bg-gray-100 text-slate-700 font-bold py-2.5 rounded-none hover:bg-gray-200 transition-colors"
              >
                Cancelar
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL CONFIGURACIÓN FINANZAS --- */}
      {showConfigModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-start justify-center pt-16 pb-4 px-4 overflow-y-auto">
          <div className="bg-white rounded-none p-6 max-w-sm w-full shadow-2xl animate-in fade-in zoom-in-95 duration-200">
            <div className="flex justify-between items-center mb-4">
              <h3 className="font-bold text-lg text-slate-800">Configuración de Finanzas</h3>
              <button onClick={() => setShowConfigModal(false)} className="text-gray-400 text-2xl leading-none">✕</button>
            </div>
            <div className="flex border-b border-gray-200 mb-4">
              <button
                onClick={() => setTabConfig('categorias')}
                className={`flex-1 py-2 text-sm font-bold uppercase tracking-wide transition-colors ${tabConfig === 'categorias' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-400'}`}
              >
                Categorías
              </button>
              <button
                onClick={() => setTabConfig('combustible')}
                className={`flex-1 py-2 text-sm font-bold uppercase tracking-wide transition-colors ${tabConfig === 'combustible' ? 'text-blue-600 border-b-2 border-blue-600' : 'text-gray-400'}`}
              >
                Combustible
              </button>
            </div>

            {tabConfig === 'categorias' && (
              <div>
                <div className="flex border-b border-gray-200 mb-3">
                  <button
                    onClick={() => setTipoCategoriaConfig('gasto')}
                    className={`flex-1 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${tipoCategoriaConfig === 'gasto' ? 'text-red-600 border-b-2 border-red-600' : 'text-gray-400'}`}
                  >
                    Gastos
                  </button>
                  <button
                    onClick={() => setTipoCategoriaConfig('ingreso')}
                    className={`flex-1 py-2 text-xs font-bold uppercase tracking-wide transition-colors ${tipoCategoriaConfig === 'ingreso' ? 'text-emerald-600 border-b-2 border-emerald-600' : 'text-gray-400'}`}
                  >
                    Ingresos
                  </button>
                </div>
                {tipoCategoriaConfig === 'gasto' ? (
                  <div>
                    <div className="flex gap-2 mb-3">
                      <input
                        type="text"
                        value={nuevaCategoria}
                        onChange={(e) => setNuevaCategoria(e.target.value)}
                        placeholder="Nueva categoría de gasto"
                        className="flex-1 border border-gray-300 p-2 rounded-none text-slate-800"
                      />
                      <button
                        onClick={() => agregarCategoriaConfig('gasto')}
                        className="bg-red-600 text-white font-bold px-4 py-2 rounded-none hover:bg-red-700 transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <div className="space-y-2">
                      {categoriasGasto.map(cat => (
                        <div key={cat} className="border border-gray-200">
                          <div className="flex items-center justify-between px-3 py-2">
                            <button
                              onClick={() => setCategoriaEnEdicion(categoriaEnEdicion === 'gasto:' + cat ? '' : 'gasto:' + cat)}
                              className="flex-1 text-left flex items-center justify-between"
                            >
                              <span className="font-medium text-slate-700">{cat}</span>
                              <span className="text-xs text-gray-400">{(subcategoriasGasto[cat] || []).length} sub</span>
                            </button>
                            <button onClick={() => eliminarCategoriaGasto(cat)} className="text-gray-400 hover:text-red-500 ml-2">✕</button>
                          </div>
                          {categoriaEnEdicion === 'gasto:' + cat && (
                            <div className="px-3 pb-3 border-t border-gray-100 pt-2">
                              <div className="flex gap-2 mb-2">
                                <input
                                  type="text"
                                  value={nuevaSubcategoria}
                                  onChange={(e) => setNuevaSubcategoria(e.target.value)}
                                  placeholder="Nueva subcategoría"
                                  className="flex-1 border border-gray-300 p-2 rounded-none text-slate-800 text-sm"
                                />
                                <button
                                  onClick={() => agregarSubcategoriaConfig('gasto', cat)}
                                  className="bg-red-600 text-white font-bold px-3 py-2 rounded-none hover:bg-red-700 transition-colors"
                                >
                                  +
                                </button>
                              </div>
                              {(subcategoriasGasto[cat] || []).length === 0 ? (
                                <p className="text-xs text-gray-400">Sin subcategorías.</p>
                              ) : (
                                <div className="flex flex-wrap gap-2">
                                  {subcategoriasGasto[cat].map(sub => (
                                    <span key={sub} className="inline-flex items-center gap-1 bg-red-50 border border-red-200 px-2 py-1 text-xs text-red-700">
                                      {sub}
                                      <button onClick={() => eliminarSubcategoriaConfig('gasto', cat, sub)} className="text-red-400 hover:text-red-500">✕</button>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <div className="flex gap-2 mb-3">
                      <input
                        type="text"
                        value={nuevaCategoria}
                        onChange={(e) => setNuevaCategoria(e.target.value)}
                        placeholder="Nueva categoría de ingreso"
                        className="flex-1 border border-gray-300 p-2 rounded-none text-slate-800"
                      />
                      <button
                        onClick={() => agregarCategoriaConfig('ingreso')}
                        className="bg-emerald-600 text-white font-bold px-4 py-2 rounded-none hover:bg-emerald-700 transition-colors"
                      >
                        +
                      </button>
                    </div>
                    <div className="space-y-2">
                      {categoriasIngreso.map(cat => (
                        <div key={cat} className="border border-gray-200">
                          <div className="flex items-center justify-between px-3 py-2">
                            <button
                              onClick={() => setCategoriaEnEdicion(categoriaEnEdicion === 'ingreso:' + cat ? '' : 'ingreso:' + cat)}
                              className="flex-1 text-left flex items-center justify-between"
                            >
                              <span className="font-medium text-slate-700">{cat}</span>
                              <span className="text-xs text-gray-400">{(subcategoriasIngreso[cat] || []).length} sub</span>
                            </button>
                            <button onClick={() => eliminarCategoriaIngreso(cat)} className="text-gray-400 hover:text-red-500 ml-2">✕</button>
                          </div>
                          {categoriaEnEdicion === 'ingreso:' + cat && (
                            <div className="px-3 pb-3 border-t border-gray-100 pt-2">
                              <div className="flex gap-2 mb-2">
                                <input
                                  type="text"
                                  value={nuevaSubcategoria}
                                  onChange={(e) => setNuevaSubcategoria(e.target.value)}
                                  placeholder="Nueva subcategoría"
                                  className="flex-1 border border-gray-300 p-2 rounded-none text-slate-800 text-sm"
                                />
                                <button
                                  onClick={() => agregarSubcategoriaConfig('ingreso', cat)}
                                  className="bg-emerald-600 text-white font-bold px-3 py-2 rounded-none hover:bg-emerald-700 transition-colors"
                                >
                                  +
                                </button>
                              </div>
                              {(subcategoriasIngreso[cat] || []).length === 0 ? (
                                <p className="text-xs text-gray-400">Sin subcategorías.</p>
                              ) : (
                                <div className="flex flex-wrap gap-2">
                                  {subcategoriasIngreso[cat].map(sub => (
                                    <span key={sub} className="inline-flex items-center gap-1 bg-emerald-50 border border-emerald-200 px-2 py-1 text-xs text-emerald-700">
                                      {sub}
                                      <button onClick={() => eliminarSubcategoriaConfig('ingreso', cat, sub)} className="text-emerald-400 hover:text-red-500">✕</button>
                                    </span>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {tabConfig === 'combustible' && (
              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">Precio de la nafta (por litro)</label>
                  <div className="flex items-center border border-gray-300 rounded-none">
                    <span className="px-3 text-slate-500 font-bold">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={precioNafta}
                      onChange={(e) => setPrecioNafta(e.target.value)}
                      placeholder="Ej: 1300"
                      className="flex-1 border-0 p-2 rounded-none text-slate-800 outline-none"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-600 mb-1">Precio del GNC (por m³)</label>
                  <div className="flex items-center border border-gray-300 rounded-none">
                    <span className="px-3 text-slate-500 font-bold">$</span>
                    <input
                      type="number"
                      inputMode="decimal"
                      value={precioGnc}
                      onChange={(e) => setPrecioGnc(e.target.value)}
                      placeholder="Ej: 900"
                      className="flex-1 border-0 p-2 rounded-none text-slate-800 outline-none"
                    />
                  </div>
                </div>
                <p className="text-xs text-gray-400">
                  Estos valores se usarán para calcular costos de combustible en otras secciones.
                </p>
                <button
                  onClick={guardarCombustibleConfig}
                  className="w-full bg-blue-600 text-white font-bold py-3 rounded-none hover:bg-blue-700 transition-colors"
                >
                  GUARDAR PRECIOS
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <MiniCalculadora
        key={calcSeq}
        abierta={calcAbierta}
        onUsar={usarCalculadora}
        onCerrar={() => setCalcAbierta(false)}
      />
    </div>
  );
}

export default App;
