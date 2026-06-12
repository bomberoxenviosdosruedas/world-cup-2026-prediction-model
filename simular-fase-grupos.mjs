import { matchProb, expectedGoals, poissonPmf } from './elo.mjs';
import fs from 'fs';

// 1. Cargar el fixture real y los datos de Elo calibrados
const fixtureReal = JSON.parse(fs.readFileSync('./data/fixture.json', 'utf8'));
const eloData = JSON.parse(fs.readFileSync('./data/elo-calibrated.json', 'utf8'));

// 2. Función matemática para calcular los marcadores exactos más probables (Hasta 5 goles)
const DC_RHO = -0.13;
function dcTau(a, b, lambda, mu, rho = DC_RHO) {
    if (a === 0 && b === 0) return 1 - lambda * mu * rho;
    if (a === 0 && b === 1) return 1 + lambda * rho;
    if (a === 1 && b === 0) return 1 + mu * rho;
    if (a === 1 && b === 1) return 1 - rho;
    return 1;
}

function obtenerMarcadoresMasProbables(ratingA, ratingB, maxGoles = 5) {
    const lambda = expectedGoals(ratingA, ratingB, 0);
    const mu = expectedGoals(ratingB, ratingA, 0);

    const combinaciones = [];
    let total = 0;

    const rawProbs = [];
    for (let gLocal = 0; gLocal <= 8; gLocal++) {
        const pLocal = poissonPmf(gLocal, lambda);
        for (let gVisita = 0; gVisita <= 8; gVisita++) {
            const pVisita = poissonPmf(gVisita, mu);
            const tau = dcTau(gLocal, gVisita, lambda, mu);
            const prob = pLocal * pVisita * tau;
            total += prob;
            if (gLocal <= maxGoles && gVisita <= maxGoles) {
                rawProbs.push({
                    marcador: `${gLocal} - ${gVisita}`,
                    golesLocal: gLocal,
                    golesVisita: gVisita,
                    probabilidadRaw: prob
                });
            }
        }
    }

    const combinacionesNormalizadas = rawProbs.map(item => ({
        marcador: item.marcador,
        golesLocal: item.golesLocal,
        golesVisita: item.golesVisita,
        probabilidad: item.probabilidadRaw / total
    }));

    return combinacionesNormalizadas
        .sort((a, b) => b.probabilidad - a.probabilidad)
        .slice(0, 3);
}

// 3. Estructuras para agrupar partidos y tablas de posiciones por grupo dinámicamente
const partidosPorGrupo = {};
const tablasPosiciones = {};

function inicializarEquipo(grupo, equipo) {
    if (!tablasPosiciones[grupo]) tablasPosiciones[grupo] = {};
    if (!tablasPosiciones[grupo][equipo]) {
        tablasPosiciones[grupo][equipo] = { equipo, pts: 0, pj: 0, gf: 0, gc: 0, dg: 0 };
    }
}

// 4. Extraer la lista de partidos (asumiendo la propiedad .matches de tu JSON)
const listaPartidos = fixtureReal.matches || [];

if (listaPartidos.length === 0) {
    console.error("❌ No se encontraron partidos en la propiedad 'matches' de tu fixture.json");
    process.exit(1);
}

// 5. Primera pasada: Agrupar y simular los partidos usando las llaves correctas (t1 y t2)
listaPartidos.forEach((partido) => {
    // Adaptación a tu JSON: Usar partido.group, partido.t1 (local) y partido.t2 (visitante)
    const grupo = partido.group || 'Grupo Desconocido';
    const local = partido.t1;
    const visitante = partido.t2;
    const jornada = partido.jornada || partido.round || 1;

    if (!local || !visitante) return; // Ignorar si el partido no está definido

    inicializarEquipo(grupo, local);
    inicializarEquipo(grupo, visitante);

    const ratingA = eloData.ratings[local];
    const ratingB = eloData.ratings[visitante];

    if (!ratingA || !ratingB) {
        // Si no encuentra el Elo exacto, intentamos limpiar guiones o espacios por si acaso
        console.warn(`⚠️ Faltan datos de Elo en el repositorio para: "${local}" o "${visitante}"`);
        return;
    }

    // Ejecutar el modelo Dixon-Coles en campo neutral
    const probs = matchProb(ratingA, ratingB, 0);
    const marcadoresTop = obtenerMarcadoresMasProbables(ratingA, ratingB);
    const marcadorSimulado = marcadoresTop[0]; // El marcador estadísticamente más probable

    // Guardar el partido procesado en su grupo correspondiente
    if (!partidosPorGrupo[grupo]) partidosPorGrupo[grupo] = [];
    partidosPorGrupo[grupo].push({
        jornada,
        local,
        visitante,
        probs,
        marcadoresTop,
        marcadorSimulado
    });

    // --- ACTUALIZAR PUNTOS Y GOLES EN LA TABLA ---
    const tLocal = tablasPosiciones[grupo][local];
    const tVisita = tablasPosiciones[grupo][visitante];

    tLocal.pj += 1;
    tVisita.pj += 1;
    tLocal.gf += marcadorSimulado.golesLocal;
    tLocal.gc += marcadorSimulado.golesVisita;
    tVisita.gf += marcadorSimulado.golesVisita;
    tVisita.gc += marcadorSimulado.golesLocal;
    tLocal.dg = tLocal.gf - tLocal.gc;
    tVisita.dg = tVisita.gf - tVisita.gc;

    if (marcadorSimulado.golesLocal > marcadorSimulado.golesVisita) {
        tLocal.pts += 3;
    } else if (marcadorSimulado.golesLocal < marcadorSimulado.golesVisita) {
        tVisita.pts += 3;
    } else {
        tLocal.pts += 1;
        tVisita.pts += 1;
    }
});

// 6. Segunda pasada: Imprimir los datos ordenados y agrupados por Grupo en la Terminal y grabarlos en un archivo
let outputText = "";
const originalLog = console.log;
console.log = (...args) => {
    const msg = args.join(" ");
    outputText += msg + "\n";
    originalLog(...args);
};

for (const grupo of Object.keys(partidosPorGrupo).sort()) {
    console.log(`\n======================================================`);
    console.log(`                 ${grupo.toUpperCase()} `);
    console.log(`======================================================`);

    // Ordenar cronológicamente los partidos de este grupo por jornada
    partidosPorGrupo[grupo].sort((a, b) => a.jornada - b.jornada);

    let jornadaActual = 0;
    partidosPorGrupo[grupo].forEach((p) => {
        if (p.jornada !== jornadaActual) {
            jornadaActual = p.jornada;
            console.log(`\n 🗓️  --- JORNADA ${jornadaActual} ---`);
        }

        console.log(`  📍 ${p.local.toUpperCase()} vs ${p.visitante.toUpperCase()}`);
        console.log(`     📊 Tendencia -> Local: ${(p.probs.winA * 100).toFixed(1)}% | Empate: ${(p.probs.draw * 100).toFixed(1)}% | Visita: ${(p.probs.winB * 100).toFixed(1)}%`);

        const marcadoresTexto = p.marcadoresTop
            .map((m, i) => `${i === 0 ? '🔥 ' : ''}[${m.marcador}] (${(m.probabilidad * 100).toFixed(1)}%)`)
            .join('   ');
        console.log(`     🎯 Top Marcadores: ${marcadoresTexto}`);
        console.log(`     ⚽ Resultado Simulado: ${p.marcadorSimulado.marcador}`);
        console.log(`  ----------------------------------------------------`);
    });

    // --- ORDENAR Y MOSTRAR LA TABLA DEL GRUPO ---
    const tablaOrdenada = Object.values(tablasPosiciones[grupo]).sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        if (b.dg !== a.dg) return b.dg - a.dg;
        return b.gf - a.gf;
    });

    console.log(`\n 📊 CLASIFICACIÓN FINAL: ${grupo.toUpperCase()}`);
    console.log(`------------------------------------------------------`);
    console.log(` POS  EQUIPO              PTS   PJ   GF   GC   DG`);
    console.log(`------------------------------------------------------`);
    tablaOrdenada.forEach((equipo, index) => {
        const nom = equipo.equipo.toUpperCase().padEnd(18, ' ');
        const pts = equipo.pts.toString().padStart(3, ' ');
        const pj = equipo.pj.toString().padStart(4, ' ');
        const gf = equipo.gf.toString().padStart(4, ' ');
        const gc = equipo.gc.toString().padStart(4, ' ');
        const dg = (equipo.dg >= 0 ? `+${equipo.dg}` : equipo.dg).toString().padStart(4, ' ');
        console.log(`  ${index + 1}.  ${nom} ${pts} ${pj} ${gf} ${gc} ${dg}`);
    });
    console.log(`======================================================\n`);
}

// Restaurar console.log y guardar el archivo de texto
console.log = originalLog;
const outputPath = './data/simulacion-grupos.txt';
fs.writeFileSync(outputPath, outputText, 'utf8');
console.log(`\n💾 Resultados guardados en: ${outputPath}\n`);
