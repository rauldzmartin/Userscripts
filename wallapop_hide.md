# Wallapop Hide Items

Userscript para [Tampermonkey](https://www.tampermonkey.net/) que oculta artículos específicos en los resultados de búsqueda de Wallapop.

## Instalación

1. Instala la extensión [Tampermonkey](https://www.tampermonkey.net/) en tu navegador.
2. Abre la URL cruda del script: https://raw.githubusercontent.com/rauldzmartin/Userscripts/main/wallapop_hide.user.js
3. Tampermonkey te mostrará la página de instalación. Pulsa *Instalar*.
4. Ve a la página de búsqueda de Wallapop (por ejemplo: https://es.wallapop.com/search?keywords=...) y usa el botón 👁 de cada tarjeta para ocultar artículos.

## Funcionalidades

- Botón 👁 en cada tarjeta para ocultar el artículo de los resultados de búsqueda.
- Los artículos ocultos desaparecen del grid sin dejar huecos (sin carruseles vacíos ni textos cortados).
- Botón **"Mostrar ocultos"** para ver temporalmente los artículos ocultos. Los que están bloqueados se marcan con un icono rojo.
- Los artículos ocultos no se ocultan en la página de favoritos.
- Cuando todos los artículos de la búsqueda están ocultos, el título del grid cambia a un mensaje informativo.
- El bloque "Similares a tu búsqueda" siempre se muestra correctamente.
- Los nuevos artículos que aparecen con la carga infinita mientras todo está oculto también se ocultan (hasta que pulses "Mostrar ocultos").

## Notas

- Los artículos ocultos se guardan en `localStorage` bajo la clave `wallapop_hidden_items`, por lo que la lista persiste entre sesiones en el mismo navegador.
- El estado del botón **"Mostrar ocultos"** también persiste: si lo dejas activado, seguirá activado tras recargar o navegar por la web.
- Los textos visibles se adaptan al idioma del dominio: español en `es.wallapop.com` e inglés en el resto.
- Funciona en `es.wallapop.com` y `wallapop.com`.
