import { matchProb } from './elo.mjs';
import fs from 'fs';

// 1. CORRECCIÓN DE RUTA: Apuntando a data\fixture.json
const fixtureReal = JSON.parse(fs.readFileSync('./data/fixture.json', 'utf8'));
const eloData = JSON.parse(fs.readFileSync('./data/elo-calibrated.json', 'utf8'));

// 2. Función matemática para calcular los marcadores exactos más probables (Hasta 5 goles)
function obtenerMarcadoresMasProbables(probs, maxGoles = 5) {
    const combinaciones = [];

    // Recorremos la matriz bivariada de Poisson (0 a 5 goles por equipo)
    for (let gLocal = 0; gLocal <= maxGoles; gLocal++) {
        for (let gVisita = 0; gVisita <= maxGoles; gVisita++) {
            let pMarcador = probs.m ? (probs.m[gLocal]?.[gVisita] || 0) : 0;

            combinaciones.push({
                marcador: `${gLocal} - ${gVisita}`,
                golesLocal: gLocal,
                golesVisita: gVisita,
                probabilidad: pMarcador
            });
        }
    }

    return combinaciones
        .sort((a, b) => b.probabilidad - a.probabilidad)
        .slice(0, 3);
}

// 3. Inicializar la estructura para las tablas de posiciones por grupo
const tablasPosiciones = {};
function inicializarEquipo(grupo, equipo) {
    if (!tablasPosiciones[grupo]) tablasPosiciones[grupo] = {};
    if (!tablasPosiciones[grupo][equipo]) {
        tablasPosiciones[grupo][equipo] = { equipo, pts: 0, pj: 0, gf: 0, gc: 0, dg: 0 };
    }
}

// 4. Procesar el calendario filtrando solo las propiedades que sean listas (grupos)
for (const [grupo, partidos] of Object.entries(fixtureReal)) {

    // Si la propiedad no es una lista de partidos, saltarla (ignora "updated", etc.)
    if (!Array.isArray(partidos)) {
        continue;
    }

    console.log(`\n======================================================`);
    console.log(`                 ${grupo.replace('_', ' ').toUpperCase()} `);
    console.log(`======================================================`);

    partidos.sort((a, b) => a.jornada - b.jornada);

    let jornadaActual = 0;

    partidos.forEach((partido) => {
        inicializarEquipo(grupo, partido.local);
        inicializarEquipo(grupo, partido.visitante);

        const ratingA = eloData[partido.local];
        const ratingB = eloData[partido.visitante];

        if (!ratingA || !ratingB) {
            console.warn(`⚠️ Error: Faltan datos de Elo para ${partido.local} o ${partido.visitante}`);
            return;
        }

        const probs = matchProb(ratingA, ratingB, false);
        const marcadoresTop = obtenerMarcadoresMasProbables(probs);
        const marcadorSimulado = marcadoresTop[0]; // Corrección para tomar el marcador dominante (Índice 0)

        if (partido.jornada !== jornadaActual) {
            jornadaActual = partido.jornada;
            console.log(`\n 🗓️  --- JORNADA ${jornadaActual} ---`);
        }

        console.log(`  📍 ${partido.local.toUpperCase()} vs ${partido.visitante.toUpperCase()}`);
        console.log(`     📊 Tendencia -> Local: ${(probs.pA * 100).toFixed(1)}% | Empate: ${(probs.pD * 100).toFixed(1)}% | Visita: ${(probs.pB * 100).toFixed(1)}%`);

        const marcadoresTexto = marcadoresTop
            .map((m, i) => `${i === 0 ? '🔥 ' : ''}[${m.marcador}] (${(m.probabilidad * 100).toFixed(1)}%)`)
            .join('   ');
        console.log(`     🎯 Top Marcadores: ${marcadoresTexto}`);
        console.log(`     ⚽ Resultado Simulado: ${marcadorSimulado.marcador}`);
        console.log(`  ----------------------------------------------------`);

        // --- ACTUALIZAR ESTADÍSTICAS Y TABLA DE POSICIONES ---
        const tLocal = tablasPosiciones[grupo][partido.local];
        const tVisita = tablasPosiciones[grupo][partido.visitante];

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

    // --- ORDENAR Y MOSTRAR LA TABLA DE POSICIONES DEL GRUPO ---
    const tablaOrdenada = Object.values(tablasPosiciones[grupo]).sort((a, b) => {
        if (b.pts !== a.pts) return b.pts - a.pts;
        if (b.dg !== a.dg) return b.dg - a.dg;
        return b.gf - a.gf;
    });

    console.log(`\n 📊 CLASIFICACIÓN FINAL: ${grupo.replace('_', ' ').toUpperCase()}`);
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
