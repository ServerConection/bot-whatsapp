# Bot de WhatsApp - Prueba Netlife

Bot de prueba con el flujo: Servicio al Cliente / Canal de Ventas.

## 1. Instalar

Requiere Node.js 18 o superior.

```
npm install
```

## 2. Configurar credenciales

Copia `.env.example` a `.env` y llena los valores:

- `WHATSAPP_TOKEN`: el token temporal que copiaste en el Paso 1 de Meta for Developers (dura 24h, si expira se regenera desde la misma pantalla).
- `PHONE_NUMBER_ID`: el ID del número de prueba, también del Paso 1.
- `VERIFY_TOKEN`: cualquier palabra secreta que tú inventes (ej: `netlife2026`). La vas a repetir en el paso 5.

## 3. Correr el bot

```
npm start
```

Debe mostrar: `Bot escuchando en el puerto 3000`.

## 4. Exponerlo a internet (para pruebas locales)

Meta necesita una URL pública para mandarte los mensajes. Si estás probando en tu computadora, usa ngrok:

```
ngrok http 3000
```

Copia la URL que te da (algo como `https://xxxx.ngrok-free.app`).

## 5. Configurar el Webhook en Meta

En tu app de Meta for Developers → WhatsApp → Configuration → Webhook → Edit:

- Callback URL: `https://xxxx.ngrok-free.app/webhook`
- Verify Token: el mismo valor que pusiste en `VERIFY_TOKEN`
- Click en "Verify and Save"
- En "Webhook fields", suscríbete al campo `messages`

## 6. Probar

Desde tu WhatsApp (el número que agregaste como destinatario de prueba), escríbele cualquier mensaje al número de prueba de Meta. Deberías recibir el menú con los botones "Servicio al Cliente" / "Canal de Ventas" y así arrancar el flujo.

## Notas

- El estado de la conversación se guarda en memoria (`sessions` en `index.js`), o sea que si reinicias el servidor se pierde el progreso de las conversaciones activas. Está bien para pruebas; para producción se recomienda pasar esto a una base de datos.
- El token temporal de WhatsApp expira cada 24h. Cuando el bot deje de responder, ese suele ser el motivo — se regenera desde la misma pantalla del Paso 1.
- Cuando quieras replicar esto en los 4 números reales de producción, solo cambias `WHATSAPP_TOKEN` y `PHONE_NUMBER_ID` por los de cada número (y usas un token permanente en vez del temporal). La lógica del bot no cambia.
