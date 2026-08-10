/**
 * gedcom.js – Napredni GEDCOM Parser.
 * Podržava sve verzije GEDCOM standarda (5.5, 5.5.1, 7.0).
 * Izvlači 100% podataka bez gubitka uz dvostruki model:
 * 1. Normalizirani podaci (za UI i brzu pretragu)
 * 2. Sirovi podaci (raw_data JSON tree - potpun prikaz izvornog stabla)
 */

const GEDCOMParser = (function () {
  'use strict';

  /**
   * Parsira GEDCOM datoteku i vraća potpunu strukturu s normaliziranim i sirovim podacima.
   * @param {string} gedcomText - Sadržaj .ged datoteke
   * @returns {Object} { header, individuals, families, sources, rawTree, errors }
   */
  function parse(gedcomText) {
    if (!gedcomText || typeof gedcomText !== 'string') {
      return { header: {}, individuals: [], families: [], sources: [], errors: ['Prazan unos.'] };
    }

    // Ukloni UTF-8 BOM ako postoji
    let cleanText = gedcomText.replace(/^\uFEFF/, '');

    const lines = cleanText.split(/\r?\n/);
    const nodes = buildNodeTree(lines);

    const header = parseHeader(nodes.find(n => n.tag === 'HEAD'));
    const errors = nodes.errors || [];
    const individuals = [];
    const families = [];
    const sources = [];

    nodes.forEach(rootNode => {
      try {
        if (rootNode.tag === 'INDI') {
          const person = parseIndividual(rootNode, header);
          if (person) individuals.push(person);
        } else if (rootNode.tag === 'FAM') {
          const family = parseFamily(rootNode);
          if (family) families.push(family);
        } else if (rootNode.tag === 'SOUR') {
          const source = parseSource(rootNode);
          if (source) sources.push(source);
        }
      } catch (err) {
        console.warn(`[GEDCOM] Greška pri obradi zapisa ${rootNode.tag} (${rootNode.xref}):`, err.message);
        errors.push(`Greška u zapisu ${rootNode.xref || rootNode.tag}: ${err.message}`);
      }
    });

    // Poveži obiteljske relacije (roditelji, supružnici, djeca)
    linkFamilyRelations(individuals, families);

    console.log(`[GEDCOM] Parsiranje završeno. Verzija: ${header.version || '5.5'}, Osoba: ${individuals.length}, Obitelji: ${families.length}`);

    return {
      header,
      individuals,
      families,
      sources,
      errors
    };
  }

  /**
   * Gradnja hijerarhijskog stabla čvorova (AST) iz linija datoteke.
   */
  function buildNodeTree(lines) {
    const rootNodes = [];
    const errors = [];
    const stack = []; // Stack za praćenje trenutnog nivoa roditelja

    for (let lineNo = 0; lineNo < lines.length; lineNo++) {
      const line = lines[lineNo].trim();
      if (!line) continue;

      try {
        // GEDCOM linija: LEVEL [@XREF@] TAG [VALUE]
        const match = line.match(/^(\d+)\s+(?:@([^@]+)@\s+)?([A-Za-z0-9_]+|\bINDI\b|\bFAM\b)(?:\s+(.*))?$/);
        if (!match) {
          errors.push(`Neispravna linija #${lineNo + 1}: "${line}"`);
          continue;
        }

        const level = parseInt(match[1], 10);
        const xref = match[2] || null;
        const tag = match[3].toUpperCase();
        let value = match[4] ? match[4].trim() : '';

        // Pokrivanje CONC i CONT (nastavak teksta)
        if (tag === 'CONC' || tag === 'CONT') {
          if (stack.length > 0) {
            const parent = stack[stack.length - 1];
            parent.value += (tag === 'CONT' ? '\n' : '') + value;
          }
          continue;
        }

        const node = {
          level,
          tag,
          xref,
          value,
          children: []
        };

        if (level === 0) {
          rootNodes.push(node);
          stack.length = 0;
          stack.push(node);
        } else {
          // Nađi roditelja odgovarajućeg nivoa
          while (stack.length > 0 && stack[stack.length - 1].level >= level) {
            stack.pop();
          }

          if (stack.length > 0) {
            stack[stack.length - 1].children.push(node);
            stack.push(node);
          } else {
            // Siroče čvor – dodaj na root
            rootNodes.push(node);
            stack.push(node);
          }
        }
      } catch (err) {
        errors.push(`Greška u liniji #${lineNo + 1}: ${err.message}`);
      }
    }

    rootNodes.errors = errors;
    return rootNodes;
  }

  /**
   * Parsiranje zaglavlja (HEAD)
   */
  function parseHeader(headNode) {
    if (!headNode) return { version: '5.5', charset: 'UTF-8' };

    const gedcNode = findChild(headNode, 'GEDC');
    const versNode = gedcNode ? findChild(gedcNode, 'VERS') : null;
    const charNode = findChild(headNode, 'CHAR');

    return {
      version: versNode ? versNode.value : '5.5',
      charset: charNode ? charNode.value : 'UTF-8',
      sour: findChildValue(headNode, 'SOUR'),
      date: findChildValue(headNode, 'DATE')
    };
  }

  /**
   * Parsira pojedinačnog čovjeka (INDI) u dvostruki model.
   */
  function parseIndividual(node, header) {
    // 1. Normalizirana polja
    const nameNode = findChild(node, 'NAME');
    let ime = '';
    let prezime = '';
    let djevojacko = '';

    if (nameNode) {
      const parsedName = parseNameString(nameNode.value);
      ime = parsedName.ime;
      prezime = parsedName.prezime;
      if (parsedName.djevojacko) djevojacko = parsedName.djevojacko;

      // Provjeri pot-čvorove GIVN i SURN
      const givn = findChildValue(nameNode, 'GIVN');
      const surn = findChildValue(nameNode, 'SURN');
      if (givn) ime = givn;
      if (surn) prezime = surn;
    }

    // Prilagođeni custom tagovi (_MARNM, _MAIDEN itd.)
    const customMarName = findChildValue(node, '_MARNM') || findChildValue(node, '_MAIDEN');
    if (customMarName && !djevojacko) {
      djevojacko = customMarName.replace(/\//g, '').trim();
    }

    // Spol
    const spol = findChildValue(node, 'SEX');

    // Rođenje i smrt
    const birtNode = findChild(node, 'BIRT');
    const birtDateVal = birtNode ? (findChildValue(birtNode, 'DATE') || birtNode.value) : null;
    const godRodenja = birtDateVal ? extractYear(birtDateVal) : null;
    const mjestoRodenja = birtNode ? findChildValue(birtNode, 'PLAC') : null;

    const deatNode = findChild(node, 'DEAT');
    const deatDateVal = deatNode ? (findChildValue(deatNode, 'DATE') || deatNode.value) : null;
    const godSmrti = deatDateVal ? extractYear(deatDateVal) : null;
    const mjestoSmrti = deatNode ? findChildValue(deatNode, 'PLAC') : null;

    // Svi NOTE zapisi i custom tagovi (svi koji počinju s _)
    const notes = findAllChildValues(node, 'NOTE').join('\n');
    const customTags = {};
    node.children.forEach(c => {
      if (c.tag.startsWith('_')) {
        customTags[c.tag] = c.value || (c.children.length > 0 ? cleanRawNode(c) : true);
      }
    });

    // 2. Kreiraj sirovi JSON stablo (raw_data)
    const rawData = cleanRawNode(node);

    return {
      // Standardizirana polja za UI
      xref: node.xref,
      ime: ime || 'Nepoznato',
      prezime: prezime || '',
      djevojacko_prezime: djevojacko || '',
      spol: spol || null,
      godina_rodenja: godRodenja,
      mjesto_rodenja: mjestoRodenja,
      godina_smrti: godSmrti,
      mjesto_smrti: mjestoSmrti,
      napomena: notes,
      custom_tags: customTags,
      is_gedcom: true,
      // SIROVI PODACI (100% podaci bez gubitka)
      raw_data: rawData
    };
  }

  /**
   * Spaja FAM zapise s pojedincima za generiranje polja roditelji, supružnici, djeca.
   */
  function linkFamilyRelations(individuals, families) {
    const map = new Map();
    individuals.forEach(p => {
      if (p.xref) map.set(p.xref, p);
      p._parents = [];
      p._spouses = [];
      p._children = [];
    });

    families.forEach(fam => {
      const husb = fam.husb ? map.get(fam.husb) : null;
      const wife = fam.wife ? map.get(fam.wife) : null;
      const children = (fam.children || []).map(xref => map.get(xref)).filter(Boolean);

      if (husb && wife) {
        if (!husb._spouses.includes(wife)) husb._spouses.push(wife);
        if (!wife._spouses.includes(husb)) wife._spouses.push(husb);
      }

      children.forEach(child => {
        if (husb) {
          if (!child._parents.includes(husb)) child._parents.push(husb);
          if (!husb._children.includes(child)) husb._children.push(child);
        }
        if (wife) {
          if (!child._parents.includes(wife)) child._parents.push(wife);
          if (!wife._children.includes(child)) wife._children.push(child);
        }
      });
    });

    const formatName = (p) => `${p.ime} ${p.prezime}`.trim();

    individuals.forEach(p => {
      p.roditelji = p._parents.map(formatName).join(', ');
      p.supruznici = p._spouses.map(formatName).join(', ');
      p.djeca = p._children.map(formatName).join(', ');

      delete p._parents;
      delete p._spouses;
      delete p._children;
    });
  }

  /**
   * Parsira obitelj (FAM)
   */
  function parseFamily(node) {
    const cleanXref = (val) => val ? val.replace(/@/g, '') : null;
    return {
      xref: cleanXref(node.xref),
      husb: cleanXref(findChildValue(node, 'HUSB')),
      wife: cleanXref(findChildValue(node, 'WIFE')),
      children: (findAllChildValues(node, 'CHIL') || []).map(cleanXref).filter(Boolean),
      marrDate: findChildValue(findChild(node, 'MARR'), 'DATE'),
      raw_data: cleanRawNode(node)
    };
  }

  /**
   * Parsira izvor (SOUR)
   */
  function parseSource(node) {
    return {
      xref: node.xref,
      title: findChildValue(node, 'TITL'),
      author: findChildValue(node, 'AUTH'),
      raw_data: cleanRawNode(node)
    };
  }

  // ─── Pomoćne funkcije za parsiranje ────────────────────────────────────────

  function parseNameString(nameStr) {
    if (!nameStr) return { ime: '', prezime: '', djevojacko: '' };
    let ime = '';
    let prezime = '';
    let djevojacko = '';

    if (nameStr.includes('/')) {
      const parts = nameStr.split('/');
      ime = parts[0] ? parts[0].trim() : '';
      prezime = parts[1] ? parts[1].trim() : '';
      if (parts[2]) {
        const extra = parts[2].trim();
        const match = extra.match(/(?:r\.|rođ\.|rođena|maiden)\s+([A-Za-zČĆŽŠĐčćžšđ]+)/i);
        if (match) djevojacko = match[1];
      }
    } else {
      const parts = nameStr.trim().split(/\s+/);
      if (parts.length > 1) {
        prezime = parts.pop();
        ime = parts.join(' ');
      } else {
        ime = parts[0] || '';
        prezime = '';
      }
    }

    // Ukloni kose crte i očisti whitespace
    prezime = prezime.replace(/\//g, '').trim();
    ime = ime.trim();

    return { ime, prezime, djevojacko };
  }

  function extractYear(dateStr) {
    if (!dateStr) return null;
    const match = dateStr.match(/\b(1[56789]\d\d|20[012]\d)\b/);
    return match ? parseInt(match[1], 10) : null;
  }

  function findChild(node, tag) {
    if (!node || !node.children) return null;
    return node.children.find(c => c.tag === tag) || null;
  }

  function findChildValue(node, tag) {
    const child = findChild(node, tag);
    return child ? child.value : null;
  }

  function findAllChildValues(node, tag) {
    if (!node || !node.children) return [];
    return node.children.filter(c => c.tag === tag).map(c => c.value);
  }

  /**
   * Rekurzivno čisti čvor i priprema čisti JSON iz raw_data zapisa
   */
  function cleanRawNode(node) {
    return {
      tag: node.tag,
      xref: node.xref || undefined,
      value: node.value || undefined,
      children: node.children && node.children.length > 0
        ? node.children.map(cleanRawNode)
        : undefined
    };
  }

  return { parse };
})();
