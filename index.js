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
  console.error('FALTAN CREDENCIALES en el archivo .env:');
  console.error('  WHATSAPP_TOKEN:', WHATSAPP_TOKEN ? 'OK' : 'FALTA');
  console.error('  PHONE_NUMBER_ID:', PHONE_NUMBER_ID ? 'OK' : 'FALTA');
  console.error('  VERIFY_TOKEN:', VERIFY_TOKEN ? 'OK' : 'FALTA');
}

// =====================================================================
// PERSISTENCIA DE SESIONES
// Si hay DATABASE_URL usa PostgreSQL. Si no, usa memoria (solo local).
// =====================================================================

// Las conexiones INTERNAS de Render (host sin puntos, ej: dpg-xxxx-a) no usan SSL.
// Las EXTERNAS (host con dominio completo) sí lo requieren.
function configSsl(url) {
  try {
    const host = new URL(url).hostname;
    return host.includes('.') ? { rejectUnauthorized: false } : false;
  } catch {
    return false;
  }
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: configSsl(DATABASE_URL),
    })
  : null;

const memoria = {}; // respaldo si no hay base de datos

async function initDb() {
  if (!pool) {
    log('Sin DATABASE_URL: las sesiones se guardan en memoria (solo para pruebas locales).');
    return;
  }
  // Esquema propio para no mezclarse con las tablas del ERP
  await pool.query('CREATE SCHEMA IF NOT EXISTS bot;');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bot.whatsapp_sesiones (
      telefono    TEXT PRIMARY KEY,
      estado      TEXT NOT NULL,
      datos       JSONB NOT NULL DEFAULT '{}'::jsonb,
      actualizado TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  log('PostgreSQL conectado. Tabla bot.whatsapp_sesiones lista.');
}

async function cargarSesion(telefono) {
  if (!pool) {
    if (!memoria[telefono]) memoria[telefono] = { state: 'START', data: {} };
    return memoria[telefono];
  }
  const r = await pool.query(
    'SELECT estado, datos FROM bot.whatsapp_sesiones WHERE telefono = $1',
    [telefono]
  );
  if (r.rows.length === 0) return { state: 'START', data: {} };
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
       SET estado = EXCLUDED.estado,
           datos = EXCLUDED.datos,
           actualizado = now()`,
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

// =====================================================================
// ENVÍO DE MENSAJES A WHATSAPP
// =====================================================================

async function sendMessage(payload) {
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
    log('>>> ENVIADO OK a', payload.to, '| tipo:', payload.type);
  }
  return json;
}

function sendText(to, body) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'text',
    text: { body },
  });
}

function sendButtons(to, bodyText, buttons) {
  return sendMessage({
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
  });
}

function sendList(to, bodyText, buttonText, rows) {
  return sendMessage({
    messaging_product: 'whatsapp',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: bodyText },
      action: {
        button: buttonText,
        sections: [{ title: 'Opciones', rows }],
      },
    },
  });
}

// =====================================================================
// RUTAS
// =====================================================================

app.get('/', (req, res) => {
  res.send('Bot activo. Todo OK.');
});

// Verificación del webhook (Meta la llama por GET al configurar)
app.get('/webhook', (req, res) => {
  log('<<< GET /webhook (verificacion de Meta)');
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Recepción de mensajes entrantes
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // Meta espera un 200 rápido, procesamos después

  try {
    log('<<< POST /webhook recibido:');
    console.log(JSON.stringify(req.body, null, 2));

    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    if (!message) {
      log('    (sin mensaje: es una notificacion de estado, se ignora)');
      return;
    }

    const from = message.from;
    const session = await cargarSesion(from);
    log(`    Mensaje de ${from} | tipo: ${message.type} | estado actual: ${session.state}`);

    let selection = null;
    if (message.type === 'text') {
      selection = message.text.body.trim();
    } else if (message.type === 'interactive') {
      if (message.interactive.type === 'button_reply') {
        selection = message.interactive.button_reply.id;
      } else if (message.interactive.type === 'list_reply') {
        selection = message.interactive.list_reply.id;
      }
    } else if (message.type === 'location') {
      const loc = message.location;
      selection = `${loc.latitude}, ${loc.longitude}${loc.address ? ' - ' + loc.address : ''}`;
    }

    log(`    Seleccion detectada: "${selection}"`);
    await handleMessage(from, session, selection);

    if (session.ended) {
      await borrarSesion(from);
      log('    Conversacion finalizada, sesion borrada.');
    } else {
      await guardarSesion(from, session);
      log(`    Sesion guardada | nuevo estado: ${session.state}`);
    }
  } catch (err) {
    console.error('>>> ERROR PROCESANDO WEBHOOK:', err);
  }
});

// =====================================================================
// LÓGICA DE LA CONVERSACIÓN
// =====================================================================

async function handleMessage(from, session, selection) {
  log(`    -> handleMessage | estado: ${session.state}`);
  switch (session.state) {
    case 'START': {
      await sendButtons(
        from,
        'Hola! bienvenido al Canal de Ventas Netlife, para darte mayor atención a tu requerimiento al seguir en la conversación aceptas nuestra política de protección de datos.',
        [
          { id: 'menu_sac', title: 'Servicio al Cliente' },
          { id: 'menu_ventas', title: 'Canal de Ventas' },
        ]
      );
      session.state = 'MAIN_MENU';
      break;
    }

    case 'MAIN_MENU': {
      if (selection === 'menu_sac') {
        await sendList(
          from,
          'Para poder entender tu novedad, por favor selecciona cuál es tu requerimiento:',
          'Ver opciones',
          [
            { id: 'sac_facturacion', title: 'Facturación' },
            { id: 'sac_sin_servicio', title: 'Sin servicio' },
            { id: 'sac_soporte', title: 'Soporte técnico' },
            { id: 'sac_nuevo_servicio', title: 'Adquirir nuevo servicio' },
            { id: 'sac_asesor', title: 'Hablar con un asesor' },
          ]
        );
        session.state = 'SAC_LIST';
      } else if (selection === 'menu_ventas') {
        await sendText(from, 'Por favor, ¿cuál es su nombre?');
        session.state = 'VENTAS_ASK_NAME';
      } else {
        // No eligió un botón: se le vuelve a mostrar el menú
        session.state = 'START';
        await handleMessage(from, session, null);
      }
      break;
    }

    case 'SAC_LIST': {
      const labels = {
        sac_facturacion: 'Facturación',
        sac_sin_servicio: 'Sin servicio',
        sac_soporte: 'Soporte técnico',
        sac_nuevo_servicio: 'Adquirir nuevo servicio',
        sac_asesor: 'Hablar con un asesor',
      };
      const label = labels[selection] || selection;
      await sendText(
        from,
        `Gracias, registramos tu solicitud sobre "${label}". Un asesor la revisará en breve.`
      );
      session.ended = true;
      break;
    }

    case 'VENTAS_ASK_NAME': {
      session.data.nombre = selection;
      await sendButtons(from, 'El servicio es para:', [
        { id: 'tipo_hogar', title: 'HOGAR' },
        { id: 'tipo_oficina', title: 'OFICINAS / PYMES' },
        { id: 'tipo_adulto_mayor', title: 'ADULTO MAYOR' },
      ]);
      session.state = 'VENTAS_ASK_TYPE';
      break;
    }

    case 'VENTAS_ASK_TYPE': {
      const labels = {
        tipo_hogar: 'HOGAR',
        tipo_oficina: 'OFICINAS / PYMES',
        tipo_adulto_mayor: 'ADULTO MAYOR',
      };
      session.data.tipo = labels[selection] || selection;
      await sendText(
        from,
        'Por favor ayúdeme con la ubicación o dirección donde va a instalar el servicio, para validar cobertura.'
      );
      session.state = 'VENTAS_ASK_LOCATION';
      break;
    }

    case 'VENTAS_ASK_LOCATION': {
      session.data.ubicacion = selection;
      await sendText(
        from,
        `¡Gracias, ${session.data.nombre}! Registramos tu solicitud para ${session.data.tipo}. Un asesor revisará tu ubicación y continuará contigo.`
      );
      log('    LEAD COMPLETO:', JSON.stringify(session.data));
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
