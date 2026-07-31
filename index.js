require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');

const app = express();
app.use(express.json());

const {
  WHATSAPP_TOKEN,
  PHONE_NUMBER_ID,
  VERIFY_TOKEN,
  DATABASE_URL,
  PORT = 3001,
} = process.env;

const GRAPH_URL = `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`;

function log(...args) {
  const hora = new Date().toLocaleTimeString('es-EC');
  console.log(`[${hora}]`, ...args);
}

if (!WHATSAPP_TOKEN || !PHONE_NUMBER_ID || !VERIFY_TOKEN) {
  console.error('FALTAN CREDENCIALES:');
  console.error('  WHATSAPP_TOKEN:', WHATSAPP_TOKEN ? 'OK' : 'FALTA');
  console.error('  PHONE_NUMBER_ID:', PHONE_NUMBER_ID ? 'OK' : 'FALTA');
  console.error('  VERIFY_TOKEN:', VERIFY_TOKEN ? 'OK' : 'FALTA');
}

// =====================================================================
// TEXTOS DEL FLUJO  (edita aquí para cambiar lo que dice el bot)
// =====================================================================

const TEXTOS = {
  bienvenida:
    '👋 ¡Hola! Gracias por contactarte con el canal de ventas de NETLIFE 🧡\n\n' +
    'Antes de continuar, te informamos que al seguir esta conversación aceptas el tratamiento ' +
    'de tus datos personales conforme a nuestras políticas de privacidad y tratamiento de datos.\n\n' +
    'Puedes consultarlas aquí:\n' +
    '📄 Política de Privacidad: https://netlife.ec/politica-privacidad/\n' +
    '📄 Política de Tratamiento de Datos Personales: https://netlife.ec/politica-tratamiento-datos-personales/',

  menuPrincipal: '👇 Por favor, indícanos el motivo de tu consulta:',

  ventasTipo: '👇 Cuéntanos, ¿el servicio de internet es para?',

  ventasUbicacion:
    '📍 ¡Perfecto! Ahora ayúdanos con la siguiente información:\n\n' +
    '🏠 Compártenos la dirección donde se instalará el servicio (calles y ciudad).\n\n' +
    '🌐 Con esta información podremos validar la cobertura y confirmar la disponibilidad ' +
    'del servicio en tu sector. ✅',

  ventasCierre: (tipo, ubi) =>
    '✅ *¡Perfecto! Hemos recibido tu información.*\n\n' +
    `📶 *Tipo de servicio:*\n${tipo}\n\n` +
    `📍 *Ubicación:*\n${ubi}\n\n` +
    '📞 En unos minutos, uno de nuestros asesores se pondrá en contacto contigo mediante ' +
    'una llamada para continuar con el proceso.\n\n' +
    '🙏 Por favor, mantente atento a tu teléfono.',

  sacMenu: '👇 Cuéntanos, ¿cuál es tu requerimiento?',

  sacCierre: (req) =>
    `✅ Hemos registrado tu requerimiento: *${req}*.\n\n` +
    '📞 Un asesor de NETLIFE se comunicará contigo en breve.\n\n' +
    '🙏 Gracias por tu paciencia.',
};

// Opciones de "Quiero Contratar" (lista: máx 24 caracteres por título)
const OPC_VENTAS = {
  vt_hogar: 'Internet Hogar / Gamer',
  vt_empresa: 'Empresas / PYMES',
  vt_adulto: 'Adulto Mayor',
};

// Opciones de "Servicio al Cliente" (lista: máx 24 caracteres por título)
const OPC_SAC = {
  sac_contratar: 'Contratar un servicio',
  sac_cancelar: 'Cancelar un servicio',
  sac_traslado: 'Traslado',
  sac_soporte: 'Soporte Técnico',
  sac_facturacion: 'Facturación',
};

// Construye las filas de lista a partir de los objetos de arriba
function filas(opciones) {
  return Object.entries(opciones).map(([id, title]) => ({ id, title }));
}

// =====================================================================
// BASE DE DATOS
// =====================================================================

// Las conexiones INTERNAS de Render (host sin puntos) no usan SSL.
function configSsl(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes('.') ? { rejectUnauthorized: false } : false;
  } catch {
    return false;
  }
}

const pool = DATABASE_URL
  ? new Pool({ connectionString: DATABASE_URL, ssl: configSsl(DATABASE_URL) })
  : null;

const memoria = {};

async function initDb() {
  if (!pool) {
    log('Sin DATABASE_URL: sesiones en memoria (solo pruebas locales).');
    return;
  }
  await pool.query('CREATE SCHEMA IF NOT EXISTS bot;');

  // Estado de conversaciones EN CURSO (se borra al terminar el flujo)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot.whatsapp_sesiones (
      telefono    TEXT PRIMARY KEY,
      estado      TEXT NOT NULL,
      datos       JSONB NOT NULL DEFAULT '{}'::jsonb,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Solicitudes completadas: esto es lo que revisa el equipo comercial
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot.leads (
      id            SERIAL PRIMARY KEY,
      telefono      TEXT NOT NULL,
      canal         TEXT NOT NULL,
      tipo_internet TEXT,
      ubicacion     TEXT,
      requerimiento TEXT,
      creado        TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Historial completo de mensajes (respaldo de los chats)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot.mensajes (
      id        BIGSERIAL PRIMARY KEY,
      telefono  TEXT NOT NULL,
      direccion TEXT NOT NULL,
      tipo      TEXT,
      contenido TEXT,
      creado    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_mensajes_telefono ON bot.mensajes (telefono, creado DESC);'
  );
  // ID que WhatsApp asigna a cada mensaje: sirve para reconocer nuestros propios envíos
  await pool.query('ALTER TABLE bot.mensajes ADD COLUMN IF NOT EXISTS wamid TEXT;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_mensajes_wamid ON bot.mensajes (wamid);'
  );

  // Números para los que el bot debe permanecer callado
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot.pausas (
      telefono      TEXT PRIMARY KEY,
      pausado_hasta TIMESTAMPTZ NOT NULL,
      motivo        TEXT,
      actualizado   TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  log('PostgreSQL conectado. Tablas listas: whatsapp_sesiones, leads, mensajes, pausas.');
}

// Si una conversación queda abandonada, después de estas horas se descarta
// y el cliente arranca de nuevo desde la bienvenida.
const HORAS_CADUCIDAD = 6;

// Cuánto se calla el bot cuando un asesor humano interviene
const HORAS_PAUSA_ASESOR = 24;

// Cuánto se calla el bot después de que el cliente termina el flujo
const DIAS_PAUSA_FIN_FLUJO = 20;

async function cargarSesion(telefono) {
  if (!pool) {
    if (!memoria[telefono]) memoria[telefono] = { state: 'START', data: {} };
    return memoria[telefono];
  }
  const r = await pool.query(
    `SELECT estado, datos,
            (actualizado < now() - INTERVAL '${HORAS_CADUCIDAD} hours') AS vencida
     FROM bot.whatsapp_sesiones WHERE telefono = $1`,
    [telefono]
  );
  if (r.rows.length === 0) return { state: 'START', data: {} };
  if (r.rows[0].vencida) {
    log('    Sesion vencida por inactividad, se reinicia el flujo.');
    return { state: 'START', data: {} };
  }
  return { state: r.rows[0].estado, data: r.rows[0].datos || {} };
}

async function guardarSesion(telefono, sesion) {
  if (!pool) {
    memoria[telefono] = sesion;
    return;
  }
  await pool.query(
    `INSERT INTO bot.whatsapp_sesiones (telefono, estado, datos, actualizado)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (telefono) DO UPDATE
       SET estado = EXCLUDED.estado, datos = EXCLUDED.datos, actualizado = now()`,
    [telefono, sesion.state, JSON.stringify(sesion.data || {})]
  );
}

async function borrarSesion(telefono) {
  if (!pool) {
    delete memoria[telefono];
    return;
  }
  await pool.query('DELETE FROM bot.whatsapp_sesiones WHERE telefono = $1', [telefono]);
}

async function guardarLead(lead) {
  if (!pool) {
    log('    (sin BD) LEAD:', JSON.stringify(lead));
    return;
  }
  await pool.query(
    `INSERT INTO bot.leads (telefono, canal, tipo_internet, ubicacion, requerimiento)
     VALUES ($1, $2, $3, $4, $5)`,
    [lead.telefono, lead.canal, lead.tipo_internet || null, lead.ubicacion || null, lead.requerimiento || null]
  );
  log('    LEAD GUARDADO:', JSON.stringify(lead));
  // El cliente terminó el flujo: el bot se calla y deja el caso al asesor
  await pausar(lead.telefono, `${DIAS_PAUSA_FIN_FLUJO} days`, 'flujo completado');
  await dispararWebhook(lead);
}

async function guardarMensaje(telefono, direccion, tipo, contenido, wamid = null) {
  if (!pool) return;
  try {
    await pool.query(
      'INSERT INTO bot.mensajes (telefono, direccion, tipo, contenido, wamid) VALUES ($1,$2,$3,$4,$5)',
      [telefono, direccion, tipo, contenido, wamid]
    );
  } catch (e) {
    console.error('Error guardando mensaje:', e.message);
  }
}

// =====================================================================
// PAUSAS DEL BOT
// =====================================================================

// Devuelve la fecha hasta la que el bot debe callarse, o null si puede hablar
async function pausaActiva(telefono) {
  if (!pool) return null;
  const r = await pool.query(
    'SELECT pausado_hasta, motivo FROM bot.pausas WHERE telefono = $1 AND pausado_hasta > now()',
    [telefono]
  );
  return r.rows[0] || null;
}

async function pausar(telefono, intervalo, motivo) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO bot.pausas (telefono, pausado_hasta, motivo, actualizado)
     VALUES ($1, now() + $2::interval, $3, now())
     ON CONFLICT (telefono) DO UPDATE
       SET pausado_hasta = EXCLUDED.pausado_hasta,
           motivo = EXCLUDED.motivo,
           actualizado = now()`,
    [telefono, intervalo, motivo]
  );
  log(`    BOT PAUSADO para ${telefono} por ${intervalo} (${motivo})`);
}

// ¿Ese ID de mensaje lo envió nuestro bot?
async function esMensajeDelBot(wamid) {
  if (!pool || !wamid) return false;
  const r = await pool.query(
    "SELECT 1 FROM bot.mensajes WHERE wamid = $1 AND direccion = 'saliente' LIMIT 1",
    [wamid]
  );
  return r.rows.length > 0;
}

// =====================================================================
// ENVÍO A WHATSAPP
// =====================================================================

async function sendMessage(payload, resumen) {
  const res = await fetch(GRAPH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json();
  if (json.error) {
    console.error('>>> ERROR AL ENVIAR:', JSON.stringify(json.error, null, 2));
  } else {
    const wamid = json.messages?.[0]?.id || null;
    log('>>> ENVIADO OK a', payload.to, '| tipo:', payload.type);
    // Guardamos el wamid para poder reconocer este mensaje como propio
    // cuando WhatsApp nos devuelva el eco.
    await guardarMensaje(payload.to, 'saliente', payload.type, resumen, wamid);
  }
  return json;
}

function sendText(to, body) {
  return sendMessage(
    { messaging_product: 'whatsapp', to, type: 'text', text: { body, preview_url: false } },
    body
  );
}

function sendButtons(to, bodyText, buttons) {
  return sendMessage(
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: bodyText },
        action: {
          buttons: buttons.map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title },
          })),
        },
      },
    },
    `${bodyText} [${buttons.map((b) => b.title).join(' | ')}]`
  );
}

function sendList(to, bodyText, buttonText, rows) {
  return sendMessage(
    {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        body: { text: bodyText },
        action: { button: buttonText, sections: [{ title: 'Opciones', rows }] },
      },
    },
    `${bodyText} [${rows.map((r) => r.title).join(' | ')}]`
  );
}

// Menú principal (se reutiliza al inicio y cuando el cliente no elige bien)
function menuPrincipal(to) {
  return sendButtons(to, TEXTOS.menuPrincipal, [
    { id: 'menu_ventas', title: 'Quiero Contratar' },
    { id: 'menu_sac', title: 'Servicio al Cliente' },
  ]);
}

// =====================================================================
// WEBHOOK DE SALIDA (Bitrix u otro sistema)
// Se dispara cuando una conversación se completa.
// Si WEBHOOK_URL no está configurada, simplemente no hace nada.
// =====================================================================

async function dispararWebhook(lead) {
  const url = process.env.WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lead),
    });
    log(`>>> WEBHOOK enviado (${res.status}):`, JSON.stringify(lead));
  } catch (e) {
    console.error('>>> ERROR enviando webhook:', e.message);
  }
}

// =====================================================================
// RUTAS
// =====================================================================

app.get('/', (req, res) => res.send('Bot activo. Todo OK.'));

app.get('/webhook', (req, res) => {
  log('<<< GET /webhook (verificacion de Meta)');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);

  try {
    const value = req.body.entry?.[0]?.changes?.[0]?.value;

    // ---- ECO: copia de un mensaje que SALIÓ desde nuestro número ----
    // Si el ID no corresponde a un envío del bot, lo escribió un asesor humano.
    const eco = value?.message_echoes?.[0];
    if (eco) {
      const cliente = eco.to;
      const propio = await esMensajeDelBot(eco.id);
      if (propio) {
        log(`<<< eco de mensaje propio (${eco.id}), se ignora`);
      } else {
        log(`<<< ECO DE ASESOR HUMANO hacia ${cliente}`);
        const texto = eco.text?.body || `[${eco.type}]`;
        await guardarMensaje(cliente, 'asesor', eco.type, texto, eco.id);
        await pausar(cliente, `${HORAS_PAUSA_ASESOR} hours`, 'intervencion de asesor');
        await borrarSesion(cliente); // el asesor toma el control
      }
      return;
    }

    const message = value?.messages?.[0];
    if (!message) return;

    const from = message.from;

    // ---- ¿El bot está en pausa para este número? ----
    const pausa = await pausaActiva(from);
    if (pausa) {
      const hasta = new Date(pausa.pausado_hasta).toLocaleString('es-EC');
      log(`<<< ${from} escribio, pero el BOT ESTA PAUSADO hasta ${hasta} (${pausa.motivo}). No se responde.`);
      await guardarMensaje(
        from,
        'entrante',
        message.type,
        message.text?.body || `[${message.type}]`
      );
      return;
    }

    const session = await cargarSesion(from);

    let selection = null;
    if (message.type === 'text') {
      selection = message.text.body.trim();
    } else if (message.type === 'interactive') {
      if (message.interactive.type === 'button_reply') selection = message.interactive.button_reply.id;
      else if (message.interactive.type === 'list_reply') selection = message.interactive.list_reply.id;
    } else if (message.type === 'location') {
      const loc = message.location;
      selection = `${loc.latitude}, ${loc.longitude}${loc.address ? ' - ' + loc.address : ''}`;
    }

    log(`<<< ${from} | tipo: ${message.type} | estado: ${session.state} | eligio: "${selection}"`);
    await guardarMensaje(from, 'entrante', message.type, selection);

    // Palabras que reinician la conversación desde cualquier punto
    const PALABRAS_REINICIO = ['menu', 'menú', 'inicio', 'hola', 'reiniciar', 'empezar'];
    if (
      message.type === 'text' &&
      PALABRAS_REINICIO.includes((selection || '').toLowerCase().trim())
    ) {
      log('    Palabra de reinicio detectada, vuelve al inicio.');
      session.state = 'START';
      session.data = {};
    }

    await handleMessage(from, session, selection);

    if (session.ended) {
      await borrarSesion(from);
      log('    Flujo terminado, sesion borrada.');
    } else {
      await guardarSesion(from, session);
      log(`    Sesion guardada | nuevo estado: ${session.state}`);
    }
  } catch (err) {
    console.error('>>> ERROR PROCESANDO WEBHOOK:', err);
  }
});

// =====================================================================
// FLUJO DE CONVERSACIÓN
// =====================================================================

async function handleMessage(from, session, selection) {
  switch (session.state) {
    // -------- Bienvenida + menú principal --------
    case 'START': {
      await sendText(from, TEXTOS.bienvenida);
      await menuPrincipal(from);
      session.state = 'MENU_PRINCIPAL';
      break;
    }

    case 'MENU_PRINCIPAL': {
      if (selection === 'menu_ventas') {
        await sendList(from, TEXTOS.ventasTipo, 'Ver opciones', filas(OPC_VENTAS));
        session.state = 'VENTAS_TIPO';
      } else if (selection === 'menu_sac') {
        await sendList(from, TEXTOS.sacMenu, 'Ver opciones', filas(OPC_SAC));
        session.state = 'SAC_MENU';
      } else {
        // No eligió una opción válida: se repite el menú
        await menuPrincipal(from);
      }
      break;
    }

    // -------- Rama QUIERO CONTRATAR --------
    case 'VENTAS_TIPO': {
      const tipo = OPC_VENTAS[selection];
      if (!tipo) {
        await sendList(from, TEXTOS.ventasTipo, 'Ver opciones', filas(OPC_VENTAS));
        break;
      }
      session.data.tipo_internet = tipo;
      await sendText(from, TEXTOS.ventasUbicacion);
      session.state = 'VENTAS_UBICACION';
      break;
    }

    case 'VENTAS_UBICACION': {
      if (!selection) {
        await sendText(from, TEXTOS.ventasUbicacion);
        break;
      }
      session.data.ubi = selection;
      await sendText(from, TEXTOS.ventasCierre(session.data.tipo_internet, session.data.ubi));
      await guardarLead({
        telefono: from,
        canal: 'ventas',
        tipo_internet: session.data.tipo_internet,
        ubicacion: session.data.ubi,
      });
      session.ended = true;
      break;
    }

    // -------- Rama SERVICIO AL CLIENTE --------
    case 'SAC_MENU': {
      const req = OPC_SAC[selection];
      if (!req) {
        await sendList(from, TEXTOS.sacMenu, 'Ver opciones', filas(OPC_SAC));
        break;
      }
      await sendText(from, TEXTOS.sacCierre(req));
      await guardarLead({ telefono: from, canal: 'servicio', requerimiento: req });
      session.ended = true;
      break;
    }

    default: {
      session.ended = true;
      break;
    }
  }
}

// =====================================================================
// ARRANQUE
// =====================================================================

initDb()
  .catch((e) => console.error('>>> ERROR conectando a PostgreSQL:', e.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log('==============================================');
      console.log(` Bot escuchando en el puerto ${PORT}`);
      console.log(` Phone Number ID: ${PHONE_NUMBER_ID}`);
      console.log(` Token cargado: ${WHATSAPP_TOKEN ? 'si (' + WHATSAPP_TOKEN.length + ' caracteres)' : 'NO'}`);
      console.log(` Sesiones: ${DATABASE_URL ? 'PostgreSQL' : 'memoria'}`);
      console.log('==============================================');
    });
  });
