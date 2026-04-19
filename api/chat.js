export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({
    error: 'ANTHROPIC_API_KEY non configurata. Vai su Vercel → Settings → Environment Variables.'
  });

  const { cols, sample, query, data } = req.body || {};
  if (!cols || !query || !data) return res.status(400).json({
    error: 'Parametri mancanti: cols, query e data sono obbligatori.'
  });

  // 1. Chiedi a Claude di generare la funzione JS
  let aiRes;
  try {
    aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 600,
        system: `Sei un motore di interrogazione dati per ERP aziendali.
Ricevi lo schema di un dataset e una richiesta in italiano o inglese.
Genera una funzione JavaScript che trasformi l'array "data" nel risultato desiderato.

Rispondi SOLO con JSON valido, nessun markdown, nessun backtick:
{"fn":"data => ...","summary":"frase breve in italiano"}

Regole:
- La funzione riceve un array di oggetti e restituisce SEMPRE un array di oggetti
- Confronti case-insensitive: str.toLowerCase().includes(x.toLowerCase())
- Numeri come stringhe: usa Number(x)
- Per aggregazioni restituisci array di oggetti con campi descrittivi
- Una sola riga, nessun blocco try/catch`,
        messages: [{
          role: 'user',
          content: `Colonne: ${cols.join(', ')}\nEsempio:\n${JSON.stringify(sample, null, 2)}\n\nRichiesta: ${query}`
        }],
      }),
    });
  } catch (e) {
    return res.status(502).json({ error: 'Errore di rete verso Anthropic: ' + e.message });
  }

  let aiBody;
  try {
    aiBody = await aiRes.json();
  } catch (e) {
    return res.status(502).json({ error: 'Risposta Anthropic non leggibile: ' + e.message });
  }

  if (!aiRes.ok) {
    const msg = aiBody?.error?.message || JSON.stringify(aiBody);
    return res.status(aiRes.status).json({ error: 'Anthropic error: ' + msg });
  }

  // 2. Estrai e parsa il JSON restituito dal modello
  let parsed;
  try {
    const raw = (aiBody?.content?.[0]?.text || '').replace(/```json|```/g, '').trim();
    if (!raw) throw new Error('Risposta vuota dal modello');
    parsed = JSON.parse(raw);
  } catch (e) {
    return res.status(500).json({ error: 'Risposta AI non parsabile: ' + e.message });
  }

  if (!parsed.fn) return res.status(500).json({
    error: 'Il modello non ha restituito una funzione valida.'
  });

  // 3. Esegui la funzione generata lato server Node.js (nessun CSP qui)
  let results;
  try {
    const fn = new Function('data', `return (${parsed.fn})(data)`);
    results = fn(data);
    if (!Array.isArray(results)) results = [];
  } catch (e) {
    return res.status(500).json({ error: 'Errore esecuzione: ' + e.message });
  }

  return res.status(200).json({ summary: parsed.summary || 'Risultati', results });
}
