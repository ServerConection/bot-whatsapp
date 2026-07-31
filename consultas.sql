-- =====================================================================
-- CONSULTAS ÚTILES DEL BOT DE WHATSAPP
-- Base: bddgeneral  |  Esquema: bot
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. LEADS (solicitudes completadas) - lo que revisa el equipo comercial
-- ---------------------------------------------------------------------

-- Todos los leads, del más reciente al más antiguo
SELECT id, telefono, canal, tipo_internet, ubicacion, requerimiento, creado
FROM bot.leads
ORDER BY creado DESC;

-- Solo leads de VENTAS
SELECT telefono, tipo_internet, ubicacion, creado
FROM bot.leads
WHERE canal = 'ventas'
ORDER BY creado DESC;

-- Solo requerimientos de SERVICIO AL CLIENTE
SELECT telefono, requerimiento, creado
FROM bot.leads
WHERE canal = 'servicio'
ORDER BY creado DESC;

-- Leads de HOY
SELECT * FROM bot.leads
WHERE creado::date = CURRENT_DATE
ORDER BY creado DESC;

-- Leads de los últimos 7 días
SELECT * FROM bot.leads
WHERE creado >= now() - INTERVAL '7 days'
ORDER BY creado DESC;

-- ---------------------------------------------------------------------
-- 2. REPORTES / MÉTRICAS
-- ---------------------------------------------------------------------

-- Cuántos leads por día
SELECT creado::date AS dia, COUNT(*) AS total
FROM bot.leads
GROUP BY dia
ORDER BY dia DESC;

-- Cuántos por canal
SELECT canal, COUNT(*) AS total
FROM bot.leads
GROUP BY canal;

-- Qué tipo de servicio piden más (ventas)
SELECT tipo_internet, COUNT(*) AS total
FROM bot.leads
WHERE canal = 'ventas'
GROUP BY tipo_internet
ORDER BY total DESC;

-- Qué requerimientos son más frecuentes (servicio al cliente)
SELECT requerimiento, COUNT(*) AS total
FROM bot.leads
WHERE canal = 'servicio'
GROUP BY requerimiento
ORDER BY total DESC;

-- ---------------------------------------------------------------------
-- 3. HISTORIAL DE CHATS (respaldo de mensajes)
-- ---------------------------------------------------------------------

-- Últimos 100 mensajes de todos los chats
SELECT telefono, direccion, tipo, contenido, creado
FROM bot.mensajes
ORDER BY creado DESC
LIMIT 100;

-- Conversación completa de un número (cambia el número)
SELECT direccion, tipo, contenido, creado
FROM bot.mensajes
WHERE telefono = '593958693149'
ORDER BY creado ASC;

-- Cuántos mensajes por día
SELECT creado::date AS dia,
       COUNT(*) FILTER (WHERE direccion = 'entrante') AS recibidos,
       COUNT(*) FILTER (WHERE direccion = 'saliente') AS enviados
FROM bot.mensajes
GROUP BY dia
ORDER BY dia DESC;

-- Personas que escribieron pero NO completaron el flujo (posibles leads perdidos)
SELECT DISTINCT m.telefono
FROM bot.mensajes m
LEFT JOIN bot.leads l ON l.telefono = m.telefono
WHERE l.id IS NULL;

-- ---------------------------------------------------------------------
-- 4. PAUSAS DEL BOT
-- ---------------------------------------------------------------------

-- Números en los que el bot está callado ahora mismo
SELECT telefono, motivo, pausado_hasta,
       pausado_hasta - now() AS tiempo_restante
FROM bot.pausas
WHERE pausado_hasta > now()
ORDER BY pausado_hasta;

-- Reactivar el bot para un número específico (quitar la pausa)
DELETE FROM bot.pausas WHERE telefono = '593958693149';

-- Reactivar el bot para TODOS (usar con cuidado)
DELETE FROM bot.pausas;

-- Cuántas veces intervino un asesor por día
SELECT creado::date AS dia, COUNT(*) AS intervenciones
FROM bot.mensajes
WHERE direccion = 'asesor'
GROUP BY dia
ORDER BY dia DESC;

-- ---------------------------------------------------------------------
-- 5. CONVERSACIONES EN CURSO (diagnóstico)
-- ---------------------------------------------------------------------

-- Quién está a mitad del flujo en este momento
SELECT telefono, estado, datos, actualizado
FROM bot.whatsapp_sesiones
ORDER BY actualizado DESC;

-- Limpiar sesiones abandonadas (más de 24 horas sin actividad)
DELETE FROM bot.whatsapp_sesiones
WHERE actualizado < now() - INTERVAL '24 hours';
