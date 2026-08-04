# Guía: agregar un número de prueba y reactivar el bot

Cada vez que agregas un número en el panel de Meta, el token se invalida y el bot
deja de responder. Esta guía lo devuelve a la vida. Sigue los pasos en orden.

Tiempo aproximado: 5 minutos.

---

## PASO 1 — Agregar el número nuevo

1. Abre esta dirección:

   https://developers.facebook.com/apps/1009566381920904/whatsapp-business/wa-dev-console/

2. Busca la sección **Envía un mensaje desde tu número de prueba**.

3. En el campo **Destinatario**, haz clic en la flechita del desplegable.

4. Elige **Administrar lista de números de teléfono** (o "Add phone number").

5. Escribe el número nuevo **con código de país y sin espacios ni guiones**.

   Ejemplo Ecuador: `593987654321`

6. Meta enviará un código por WhatsApp o SMS a ese número.
   Pide el código a la persona dueña del número y escríbelo para confirmar.

7. Listo, el número queda agregado.

> Recuerda: el máximo son 5 números.

---

## PASO 2 — Copiar el token nuevo

El token cambió solo al agregar el número. Hay que copiar el nuevo.

1. En esa misma página, busca el campo **Token de acceso**.

2. Haz clic en el ícono de copiar (las dos hojitas, a la derecha del campo).

3. Pégalo en el Bloc de notas por ahora. Le diremos **TOKEN CORTO**.

---

## PASO 3 — Copiar la clave secreta

(Si ya la tienes guardada de antes, salta al Paso 4.)

1. Abre esta dirección:

   https://developers.facebook.com/apps/1009566381920904/settings/basic/

2. Busca el campo **Clave secreta de la app**.

3. Haz clic en **Mostrar**.

4. Escribe tu contraseña de Facebook cuando la pida.

5. Copia la clave y pégala en el Bloc de notas. Le diremos **CLAVE SECRETA**.

---

## PASO 4 — Convertir el token de 24 horas en uno de 60 días

1. Copia esta dirección al Bloc de notas:

```
https://graph.facebook.com/v20.0/oauth/access_token?grant_type=fb_exchange_token&client_id=1009566381920904&client_secret=CLAVE_SECRETA&fb_exchange_token=TOKEN_CORTO
```

2. Reemplaza en esa dirección:
   - Donde dice `CLAVE_SECRETA` → pega tu clave secreta
   - Donde dice `TOKEN_CORTO` → pega el token del Paso 2

3. Copia la dirección ya completa y pégala en el navegador. Presiona Enter.

4. Verás una respuesta así:

```
{"access_token":"EAAOxxxxxxxxxxxxx","token_type":"bearer","expires_in":5184000}
```

5. **Verifica que `expires_in` sea un número cercano a 5184000.**
   Si es así, son 60 días y todo va bien.

6. Copia **únicamente** lo que está entre las comillas después de `"access_token":`

   Es decir, solo esto: `EAAOxxxxxxxxxxxxx`

   NO copies las comillas. NO copies la coma. NO copies `token_type` ni lo demás.

   Este es el **TOKEN LARGO**.

---

## PASO 5 — Ponerlo en Render

1. Abre https://dashboard.render.com

2. Haz clic en el servicio **bot-whatsapp**.

3. En el menú de la izquierda, haz clic en **Environment**.

4. Busca la variable **WHATSAPP_TOKEN**.

5. Haz clic para editarla. **Borra todo el contenido viejo.**

6. Pega el TOKEN LARGO del Paso 4.

7. Haz clic en **Save Changes**.

8. Render reinicia el servicio solo. Espera unos 2 minutos.

---

## PASO 6 — Comprobar que quedó bien

1. En Render, haz clic en la pestaña **Logs**.

2. Espera hasta ver un bloque como este:

```
==============================================
 Bot escuchando en el puerto 10000
 Phone Number ID: 1167268509811464
 Token cargado: si (196 caracteres)
 Sesiones: PostgreSQL
==============================================
```

3. Debe decir `Token cargado: si`. Si dice `NO`, la variable quedó vacía.

---

## PASO 7 — Probar el bot

1. Desde el WhatsApp del número que agregaste, escribe al número de prueba:

   **+1 555-659-4581**

2. Envía la palabra:

```
funel1
```

   Esa palabra reactiva el bot aunque esté pausado. Es la forma segura de probar.

3. Debe llegarte el mensaje de bienvenida con los botones
   **Quiero Contratar** y **Servicio al Cliente**.

Si llegó: todo funciona. Terminaste.

---

## SI ALGO FALLA

### El bot no responde nada

Revisa los logs de Render. Busca la línea del error:

- **`Authentication Error`, `code: 190`**
  El token no sirve. Repite desde el Paso 2.

- **`Cannot parse access token`**
  Se copiaron comillas o espacios de más. Repite el Paso 4 copiando solo el token.

- **No aparece ninguna línea nueva al escribir**
  El webhook no está llegando. Verifica en Meta que la Callback URL sea:
  `https://bot-whatsapp-7rbh.onrender.com/webhook`

### Quiero probar sin esperar

Escribe `funel1` al bot. Siempre reactiva y responde, sin importar las pausas.

### El cliente quedó atascado a la mitad

En tu base de datos:

```sql
DELETE FROM bot.whatsapp_sesiones WHERE telefono = '593987654321';
DELETE FROM bot.pausas WHERE telefono = '593987654321';
```

---

## RECORDATORIOS

- El token dura **60 días**. Anota la fecha en que lo generaste.
- Cada vez que toques el panel del Paso 1 (agregar números, ver el token),
  el token se invalida y hay que repetir esta guía.
- Máximo **5 números** de prueba.
- Esto se acaba cuando pasemos a los números de producción con token de
  usuario del sistema, que no caduca nunca.
