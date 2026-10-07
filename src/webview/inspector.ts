import type { ObjectInfo } from '../shared/types';

const formatNumber = (value: number) => value.toFixed(2);

/** Label/value rows for the inspector panel, in reading order, leaving out what the object lacks. */
export function inspectorRows(info: ObjectInfo): [string, string][] {
  const rows: [string, string][] = [['Type', info.type]];
  if (info.block) rows.push(['Block', info.block]);
  rows.push(['Layer', info.layer]);
  if (info.handle) rows.push(['Handle', info.handle]);
  if (info.position) rows.push(['Position', `${formatNumber(info.position.x)}, ${formatNumber(info.position.y)}`]);
  if (info.rotation !== undefined) rows.push(['Rotation', `${Math.round(info.rotation * 100) / 100}°`]);
  if (info.scale) rows.push(['Scale', `${info.scale.x} × ${info.scale.y}`]);
  if (info.text) rows.push(['Text', info.text]);
  return rows;
}

/**
 * The floating panel describing the selected object. `layerColor` gives the
 * swatch beside the layer name; `onClose` runs on the × button.
 */
export function buildInspector(info: ObjectInfo, layerColor: string | undefined, onClose: () => void): HTMLElement {
  const panel = document.createElement('div');
  panel.className = 'dwg-inspector';

  const header = document.createElement('div');
  header.className = 'dwg-inspector-header';
  const title = document.createElement('span');
  title.className = 'dwg-inspector-title';
  title.textContent = info.block ?? info.type;
  const close = document.createElement('button');
  close.className = 'dwg-inspector-close';
  close.textContent = '×';
  close.title = 'Close (Esc)';
  close.setAttribute('aria-label', 'Close object details');
  close.addEventListener('click', onClose);
  header.append(title, close);
  panel.appendChild(header);

  const table = document.createElement('table');
  table.className = 'dwg-inspector-table';
  const addRow = (label: string, value: string, swatch?: string) => {
    const row = table.insertRow();
    const name = row.insertCell();
    name.className = 'dwg-inspector-label';
    name.textContent = label;
    const cell = row.insertCell();
    if (swatch) {
      const chip = document.createElement('span');
      chip.className = 'dwg-layer-swatch';
      chip.style.background = swatch;
      cell.appendChild(chip);
    }
    cell.appendChild(document.createTextNode(value));
  };
  for (const [label, value] of inspectorRows(info)) {
    addRow(label, value, label === 'Layer' ? layerColor : undefined);
  }
  panel.appendChild(table);

  if (info.attributes?.length) {
    const heading = document.createElement('div');
    heading.className = 'dwg-inspector-section';
    heading.textContent = `Attributes (${info.attributes.length})`;
    panel.appendChild(heading);

    const attributes = document.createElement('table');
    attributes.className = 'dwg-inspector-table';
    for (const attribute of info.attributes) {
      const row = attributes.insertRow();
      if (attribute.hidden) row.className = 'dwg-inspector-hidden';
      const tag = row.insertCell();
      tag.className = 'dwg-inspector-label';
      tag.textContent = attribute.tag;
      row.insertCell().textContent = attribute.hidden ? `${attribute.value} (hidden)` : attribute.value;
    }
    panel.appendChild(attributes);
  }

  return panel;
}
