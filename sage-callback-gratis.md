# SAGE → NOTIFICACIÓN "CLIENTE PIDE HABLAR CON UNA PERSONA"

Costo: **$0**. Sin tarjeta, sin plan de pago. Usa Google Apps Script, que ya viene con tu cuenta de Google.

Tiempo de armado: ~10 minutos.

---

## CÓMO FUNCIONA

1. Cliente le dice a Sage que quiere hablar con alguien
2. Sage le pide nombre y teléfono
3. Sage manda esos datos a una URL tuya
4. Te llega un correo al instante
5. Tú le devuelves la llamada

Sage **nunca** dice que está conectando a nadie. Dice que va a pedir que le llamen, que es lo que de verdad pasa.

---

# PARTE 1 — EL RECEPTOR (Google Apps Script)

## 1.1 Crear el script

Ve a **script.google.com** → **Nuevo proyecto**. Borra lo que traiga y pega esto:

```javascript
// ── CONFIGURACIÓN ────────────────────────────────────────────
// Cambia estas dos líneas antes de desplegar.
const SECRET  = 'bridg_7hK92xQm4vZp';          // inventa una clave larga tuya
const DESTINO = 'k.vargas@novarholding.com';   // a dónde llega el aviso
// ─────────────────────────────────────────────────────────────

function doPost(e) {
  try {
    // Rechaza cualquier POST que no traiga la clave en la URL
    if (!e || !e.parameter || e.parameter.k !== SECRET) {
      return json({ ok: false, error: 'unauthorized' });
    }

    var d = {};
    if (e.postData && e.postData.contents) {
      d = JSON.parse(e.postData.contents);
    }

    var nombre = (d.nombre   || '').toString().trim() || 'sin nombre';
    var tel    = (d.telefono || '').toString().trim() || 'sin número';
    var motivo = (d.motivo   || '').toString().trim() || 'no especificado';
    var idioma = (d.idioma   || '').toString().trim();

    var hora = Utilities.formatDate(
      new Date(), 'America/Los_Angeles', "d 'de' MMMM, h:mm a"
    );

    var asunto = 'SAGE — ' + nombre + ' pide hablar con una persona';

    var cuerpo =
      'Un cliente pidió hablar con alguien del equipo.\n\n' +
      'NOMBRE:   ' + nombre + '\n' +
      'TELÉFONO: ' + tel    + '\n' +
      'MOTIVO:   ' + motivo + '\n' +
      (idioma ? 'IDIOMA:   ' + idioma + '\n' : '') +
      '\nRecibido: ' + hora + ' (hora del Pacífico)\n' +
      '\n— Enviado automáticamente por Sage';

    MailApp.sendEmail(DESTINO, asunto, cuerpo);

    return json({ ok: true, message: 'Solicitud registrada' });

  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
```

**Cambia las dos primeras líneas** — la clave secreta (inventa una, larga, sin espacios) y el correo destino.

## 1.2 Desplegarlo

1. Arriba a la derecha: **Implementar** → **Nueva implementación**
2. Engranaje ⚙️ junto a "Seleccionar tipo" → **Aplicación web**
3. **Ejecutar como:** Yo (tu cuenta)
4. **Quién tiene acceso:** **Cualquier usuario** ← obligatorio, si no ElevenLabs no puede llamarlo
5. **Implementar**
6. Google te va a pedir autorización. Va a salir una pantalla de advertencia — es tu propio script, dale **Configuración avanzada** → **Ir a (nombre del proyecto)** → **Permitir**
7. Copia la **URL de la aplicación web**. Termina en `/exec`

## 1.3 Armar la URL final

Pégale la clave al final:

```
https://script.google.com/macros/s/AKfy...TU_ID.../exec?k=bridg_7hK92xQm4vZp
```

Esa es la URL que va en ElevenLabs. **Guárdala, no la compartas** — quien la tenga puede mandarte correos.

## 1.4 Probarlo

Antes de tocar ElevenLabs, comprueba que funciona. En la Terminal de tu Mac:

```bash
curl -L -X POST "TU_URL_COMPLETA_CON_?k=" \
  -H "Content-Type: application/json" \
  -d '{"nombre":"Prueba","telefono":"818-555-0100","motivo":"probando el sistema"}'
```

Si te llega el correo, ya está. Si no llega, revisa que "Quién tiene acceso" esté en **Cualquier usuario**.

---

# PARTE 2 — EL TOOL EN ELEVENLABS

**Tools** → **Add tool** → **Webhook** (no "Integration").

| Campo | Valor |
|---|---|
| **Name** | `solicitar_callback` |
| **Method** | `POST` |
| **URL** | Tu URL completa con `?k=...` |

**Description** — esto es lo que decide cuándo Sage lo usa, así que copia el texto exacto:

```
Registra una solicitud de devolución de llamada cuando el cliente
quiere hablar con una persona del equipo de Bridg. Llama a esta
herramienta SOLO después de que el cliente te haya dado su nombre
y su número de teléfono. Úsala cuando el cliente pida hablar con
un humano o agente, cuando esté molesto o frustrado, cuando
reporte daño o material faltante, cuando pregunte por una factura
o un saldo específico, o cuando pregunte algo que no puedes
responder. No la uses para preguntas generales de precios,
cobertura o vehículos.
```

**Body parameters** — cuatro, todos tipo `string`:

| Nombre | Requerido | Descripción para el LLM |
|---|---|---|
| `nombre` | Sí | Nombre del cliente tal como lo dio |
| `telefono` | Sí | Número de teléfono del cliente |
| `motivo` | Sí | Resumen en una frase de por qué quiere hablar con alguien |
| `idioma` | No | "español" o "inglés", según el idioma de la conversación |

---

# PARTE 3 — EL CAMBIO EN EL PROMPT

Agrega esta sección al system prompt de Sage, justo después de **ESCALATION**:

```markdown
## REQUESTING A CALLBACK

You cannot transfer anyone to a person. There is no live handoff.
**Never say "connecting you to a human," "transferring you,"
"one moment while I get someone," or anything implying a person
is joining the conversation.** That is a false promise and it is
worse than saying no.

What you can do is register a callback request. When someone
wants to talk to a person:

**EN:** "I can't transfer you from here, but I can have someone
from our team call you. What's your name and the best number to
reach you?"

**ES:** "No te puedo transferir desde aquí, pero sí puedo pedir
que alguien del equipo te llame. ¿Cuál es tu nombre y el mejor
número para contactarte?"

Once they give you both, call the `solicitar_callback` tool with
their name, their number, and a one-sentence summary of why.

Then confirm plainly:

**EN:** "Got it — someone from our team will reach out to you at
that number as soon as possible. If you'd rather pick a time
yourself, use the Book a call button on this page."

**ES:** "Listo — alguien de nuestro equipo te va a contactar a ese
número lo más pronto posible. Si prefieres elegir la hora tú, usa
el botón Agendar llamada de esta página."

**Do not name a specific time.** "As soon as possible" and "lo más
pronto posible" are the strongest commitments you may make. Never
say "in five minutes," "within the hour," "today," "right away,"
or any figure. If the customer pushes for a specific time, tell
them you can't commit to one and point them at the Book a call
button, where they choose the slot themselves.

If they refuse to give a name or number, don't push. Point them
at the Book a call button on this page and leave it there.

Trigger this flow when the person: asks for a human, agent, or
representative; says they don't want to talk to a bot or AI;
sounds frustrated or angry; reports damaged, missing, or wrong
material; asks about a specific invoice, balance, refund, or
dispute; or asks something you cannot answer.
```

---

# NOTAS

**Límite de correos.** Apps Script permite 100 correos al día en cuenta gratuita de Gmail. Muy por encima de lo que vas a necesitar.

**Si algún día quieres SMS en vez de correo:** casi todas las operadoras tienen puerta de enlace correo→SMS. Cambia `DESTINO` a tu número con el dominio de tu operadora. Es gratis pero poco confiable — para empezar, el correo con notificación en el teléfono funciona mejor.

**Registro en hoja de cálculo (opcional).** Si después quieres que cada solicitud también se guarde en Google Sheets, se agregan tres líneas al script. Pídemelo cuando lo quieras.

**El cambio de prompt es independiente del tool.** Aunque no armes nada de esto, quita ya la frase de "te estoy conectando con un humano". Un cliente molesto esperando a alguien que nunca llega es peor que un no.
