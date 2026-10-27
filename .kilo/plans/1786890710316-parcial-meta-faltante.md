# Plan: Mostrar faltante para meta del día en modales de registro parcial

## Contexto
El usuario quiere que, dentro del recuadro de información del corte parcial (tanto real como simulador), se muestre como información más importante cuánto falta para completar la meta del día. Esa información debe estar siempre visible (no condicionada a que ya haya valores cargados), porque representa el objetivo fijo del día hasta que se haga el cierre.

Actualmente:
- Modal real (`showParcialModal`): el recuadro ámbar solo aparece cuando hay valores ingresados, y el bloque de "Progreso hacia meta" está dentro de esa condición.
- Modal simulador (`showSimParcialModal`): el recuadro ámbar solo aparece cuando hay valores, y no tiene bloque de progreso hacia la meta.

## Cambios a realizar

### 1. Modal Parcial Real (`showParcialModal`, ~líneas 1815-1852)
- Eliminar la condición que oculta el recuadro ámbar. Ahora debe mostrarse siempre.
- Reestructurar el contenido del recuadro:
  - **Info principal (siempre visible):** "Falta para la meta de hoy: $X" con el cálculo `Math.max(0, objetivoHoy - (parcialUber + parcialDidi))`.
  - **Barra de progreso:** visible siempre, con el porcentaje calculado sobre `objetivoHoy`.
  - **Texto complementario (solo si hay parcial cargado):** "Llevas $Y de $Z" mostrando el avance.
  - **Subtotal y promedio (condicionados a que haya valores):** se mantienen igual, pero dentro de un `border-t border-amber-300` para separarlos visualmente de la info de la meta.

### 2. Modal Parcial Simulador (`showSimParcialModal`, ~líneas 1619-1632)
- Eliminar la condición que oculta el recuadro ámbar. Ahora debe mostrarse siempre.
- Insertar al principio del recuadro el mismo bloque de "Falta para la meta de hoy" usando las variables del simulador (`ingresoUberSimParcial`, `ingresoDidiSimParcial`, `horasTrabajadasSimParcial`, `objetivoHoy`).
- Mantener el subtotal y promedio dentro de una sub-sección condicional separada por `border-t border-amber-300`.

## Datos disponibles
- `objetivoHoy`: disponible en el scope de `App`, se calcula en `const objetivoHoy = dias.find(d => d.dia === diaSeleccionado)?.esperado || 0;` (~línea 327).
- Variables de estado para parcial real: `ingresoUberParcial`, `ingresoDidiParcial`, `horasTrabajadasParcial`.
- Variables de estado para parcial simulador: `ingresoUberSimParcial`, `ingresoDidiSimParcial`, `horasTrabajadasSimParcial`.

## Validación
- Abrir modal de parcial real sin valores cargados → debe mostrar el recuadro con "Falta $X" y barra vacía.
- Abrir modal de parcial simulador sin valores cargados → debe mostrar el recuadro con "Falta $X" y barra vacía.
- Cargar valores en cualquier modal → el faltante se actualiza y la barra de progreso crece.
- El resto de la UI no se modifica; solo se altera el comportamiento de estos dos modales.

## Archivos afectados
- `src/App.jsx` únicamente.
