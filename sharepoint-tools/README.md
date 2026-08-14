# SharePoint Tools (SP List Inspector) v2.9

Userscript de Tampermonkey para inspeccionar y exportar listas de **SharePoint Modern** a través de la REST API.

## Instalación

1. Instala [Tampermonkey](https://www.tampermonkey.net/) en tu navegador.
2. Abre el script en crudo: `https://raw.githubusercontent.com/rauldzmartin/Userscripts/main/sharepoint-tools/sharepoint_tools.js`
3. Tampermonkey te ofrecerá instalarlo — acepta.

## Uso

Una vez cargado, aparece un botón flotante 🛠️ en la esquina inferior derecha. Su comportamiento depende de la página:

| Modo | Dónde aparece | Acción |
|---|---|---|
| **Copy list** | En cualquier vista de lista o biblioteca (`listTitle` activo) | Copia al portapapeles la estructura completa de la lista (columnas, tipos, vistas, content types) + los registros visibles en pantalla |
| **Export site** | En la página *Contenido del sitio* (`viewlsts.aspx`) | Exporta un JSON con todas las listas/bibliotecas del sitio, incluyendo todos sus campos y **todos sus registros** (con paginación automática), y descarga el archivo `sp_{sitio}_{timestamp}.json` |

También puedes pulsar **Alt+C** para ejecutar la acción correspondiente a la página actual.

### Ejemplo de output (modo lista)

```json
{
  "_meta": { "tool": "SP List Inspector v2.9", "mode": "visible-rows-full", "...": "..." },
  "structure": { "totalColumns": 12, "columns": [...] },
  "data": { "rowCount": 25, "rows": [...] }
}
```

## Detalles técnicos

- Usa `_spPageContextInfo` para detectar el contexto (lista activa o sitio).
- Filtra claves internas de OData/SharePoint (`odata.*`, `FileSystemObjectType`, lookup `*Id`, etc.) para que el JSON solo contenga datos de negocio.
- `fetchAllItems()` pagina la API automáticamente (`$top=5000` + `odata.nextLink`) y reintenta con backoff exponencial ante throttling (429).
- Reacciona a la navegación SPA de SharePoint Modern (wrapper de `history.pushState` + `popstate`).
- Los campos lookup se resuelven contra la lista de origen (título y URL de la vista).
- Los registros de ejemplo se limpian de valores por defecto (`null`, `false`, solo `Id`) para que sean representativos.

## Requisitos

- `@grant GM_setClipboard` (para el portapapeles)
- `@match https://*.sharepoint.com/sites/*/*`

## Changelog

| Versión | Cambios |
|---|---|
| 2.9 | Versión actual del repo organizado en subcarpetas |