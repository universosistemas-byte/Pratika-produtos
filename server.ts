import express from 'express';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import google from 'googlethis';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import https from 'https';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

// Setup multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Create an https agent to ignore cert errors on test environment
const httpsAgent = new https.Agent({ rejectUnauthorized: false });


// Setup Gemini
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    },
  },
});

// Global tracker for model health
const modelCooldowns: Record<string, number> = {};

function isModelOnCooldown(model: string): boolean {
  const cooldownUntil = modelCooldowns[model];
  if (!cooldownUntil) return false;
  if (Date.now() < cooldownUntil) {
    return true;
  }
  // Cooldown expired
  delete modelCooldowns[model];
  return false;
}

function setModelCooldown(model: string, durationMs: number = 30000) {
  modelCooldowns[model] = Date.now() + durationMs;
  console.log(`[MODEL-HEALTH] Modelo ${model} em cooldown por ${durationMs / 1000} segundos.`);
}

async function generateContentWithFallback(options: {
  contents: any;
  config?: any;
}) {
  const allModels = ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-flash-latest'];
  
  // Prioritize models that are NOT on cooldown
  const availableModels = allModels.filter(m => !isModelOnCooldown(m));
  const onCooldownModels = allModels.filter(m => isModelOnCooldown(m));
  const modelsToTry = [...availableModels, ...onCooldownModels];

  if (availableModels.length === 0) {
    console.warn(`[MODEL-HEALTH] Todos os modelos estão em cooldown. Tentando de qualquer forma.`);
  }

  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      console.log(`[GEMINI-CALL] Tentando gerar conteúdo com o modelo: ${model}`);
      const response = await ai.models.generateContent({
        model: model,
        contents: options.contents,
        config: options.config,
      });
      return response;
    } catch (err: any) {
      lastError = err;
      const errMsg = String(err.message || '').toLowerCase();
      console.warn(`[GEMINI-CALL] Falha no modelo ${model}: ${err.message}`);
      
      if (
        errMsg.includes('429') || 
        errMsg.includes('quota') || 
        errMsg.includes('limit') || 
        errMsg.includes('exhausted') || 
        errMsg.includes('resource_exhausted') || 
        errMsg.includes('503') ||
        errMsg.includes('unavailable') ||
        errMsg.includes('not found') || 
        errMsg.includes('model')
      ) {
        // Parse custom retry delay if provided in the error message
        let cooldownMs = 30000; // default 30s
        const retryDelayMatch = errMsg.match(/retry in ([\d\.]+)s/i) || errMsg.match(/retry after ([\d\.]+)s/i);
        if (retryDelayMatch && retryDelayMatch[1]) {
          cooldownMs = Math.ceil(parseFloat(retryDelayMatch[1])) * 1000 + 1000;
        } else if (errMsg.includes('503') || errMsg.includes('unavailable')) {
          cooldownMs = 15000; // 15s for 503
        }
        
        setModelCooldown(model, cooldownMs);
        console.log(`[GEMINI-CALL] Erro de quota/indisponibilidade no modelo ${model}. Tentando próximo modelo...`);
        continue;
      } else {
        // Break early if it's a validation error or structural failure
        throw err;
      }
    }
  }
  throw lastError || new Error('Todos os modelos de IA falharam por limite de cota ou indisponibilidade.');
}

app.use(express.json({ limit: '10mb' }));

app.post('/api/extract-menu', upload.any(), async (req, res) => {
  try {
    const uploadedFiles = req.files as Express.Multer.File[] | undefined;
    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ error: 'Nenhuma imagem de cardápio foi enviada.' });
    }

    const sessionToken = req.body.sessionToken;
    const erpUrl = (req.body.erpUrl || 'https://teste.pratikapdv.com').replace(/\/+$/, '');
    let groupsContext = '';

    if (sessionToken) {
      try {
        const groupsRes = await axios.post(
          `${erpUrl}/produto/grupo/listar`,
          {},
          {
            headers: {
              'Accept': 'application/json, text/javascript, */*; q=0.01',
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
              'Cookie': `SESSION=${sessionToken}`,
              'Origin': erpUrl,
              'Referer': `${erpUrl}/`,
              'Sec-Fetch-Dest': 'empty',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
              'X-Requested-With': 'XMLHttpRequest',
              'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"'
            },
            httpsAgent,
          }
        );
        
        let groupsList = Array.isArray(groupsRes.data) ? groupsRes.data : groupsRes.data?.aaData || groupsRes.data?.data || groupsRes.data;
        if (groupsList && Array.isArray(groupsList)) {
          // Simplify groups object to not break token limits
          const simplifiedGroups = groupsList.map((g: any) => ({
            CodigoProdutoGrupo: g.CodigoProdutoGrupo || g.id || g.codigo,
            Nome: g.Nome || g.nome || g.name || g.descricao,
          })).filter(g => g.CodigoProdutoGrupo);
          
          groupsContext = `IMPORTANTE: Aqui estão os grupos cadastrados: ${JSON.stringify(simplifiedGroups)}. VOCÊ DEVE EXCLUSIVAMENTE escolher e atribuir em "groupId" o 'CodigoProdutoGrupo' de um destes grupos correspondentes. NÃO INVENTE NENHUM CODIGO. Se nenhum for correspondente, use "1".`;
        }
      } catch (e: any) {
        console.error('Falha ao obter lista de grupos', e.message);
      }
    }

    const promptText = `Extraia todos os itens deste cardápio. Para cada item, identifique o nome, preço e invente um código de barras se não houver um visível (use números com 13 dígitos como EAN). Se não tiver preço claro, coloque 0. Determine também um Código NCM (Nomenclatura Comum do Mercosul) de 8 dígitos adequado no Brasil. Se o item tiver opções de sabores/tipos (ex: "Refrigerante 300ml" com opções Coca-cola, Fanta, etc), crie um único produto genérico e preencha a lista 'variations' com essas opções. Extraia também em 'variationGroupName' um nome lógico e genérico que possa ser compartilhado entre outros produtos com esse mesmo propósito exato (ex: "OPÇÕES DE CALDO", "TAMANHOS DE PIZZA", "SABORES DE REFRIGERANTE"). Não use o nome de um produto específico na variação para que o mesmo grupo seja reaproveitado em massa. ${groupsContext}`;

    const parts: any[] = [];
    for (const f of uploadedFiles) {
      parts.push({
        inlineData: {
          mimeType: f.mimetype,
          data: f.buffer.toString('base64'),
        },
      });
    }
    parts.push({ text: promptText });

    let response;
    let attempts = 0;
    while (attempts < 5) {
      try {
        response = await generateContentWithFallback({
          contents: {
            parts: parts,
          },
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: {
                    type: Type.STRING,
                    description: 'Nome do produto',
                  },
                  price: {
                    type: Type.NUMBER,
                    description: 'Preço numérico do produto',
                  },
                  barcode: {
                    type: Type.STRING,
                    description: 'Código de barras',
                  },
                  groupId: {
                     type: Type.STRING,
                     description: 'CodigoProdutoGrupo escolhido para este item, com base nos dados informados. Se os grupos forem informados, use o ID correspondente.',
                  },
                  ncm: {
                    type: Type.STRING,
                    description: 'Código NCM (Nomenclatura Comum do Mercosul) com 8 dígitos adequado para este produto.'
                  },
                  variationGroupName: {
                    type: Type.STRING,
                    description: 'Um nome genérico, curto e reutilizável para o grupo destas variações (ex: "OPÇÕES DE CALDO", "TAMANHOS DE PIZZA", "SABORES DE REFRIGERANTE"). Se houver múltiplos produtos com o mesmo conjunto de opções, use o exato mesmo nome para eles.'
                  },
                  variations: {
                    type: Type.ARRAY,
                    description: 'Se o produto for um item genérico e tiver opções/variações (ex: "Refrigerante Lata 300ml" e as variações "Coca-Cola", "Fanta"), liste as variações aqui.',
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        name: { type: Type.STRING },
                        price: { type: Type.NUMBER }
                      },
                      required: ['name', 'price']
                    }
                  }
                },
                required: ['name', 'price', 'barcode'],
              },
            },
          }
        });
        break; // success
      } catch (err: any) {
        attempts++;
        console.warn(`Extraction attempt ${attempts} failed: ${err.message}`);
        if (attempts >= 5) {
          throw err;
        }
        
        let delay = 3000 * Math.pow(2, attempts - 1); // 3s, 6s, 12s, 24s
        // Extract retryDelay from error if present (e.g. "Please retry in 19.5s")
        const match = err.message?.match(/retry in ([\d\.]+)s/i);
        if (match && match[1]) {
           const suggestedDelay = Math.ceil(parseFloat(match[1])) * 1000;
           delay = Math.max(delay, suggestedDelay + 1000); // add 1s buffer
        }
        
        console.log(`Waiting for ${delay}ms before next attempt...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }

    const extractedProducts = JSON.parse(response?.text?.trim() || '[]');

    res.json({ products: extractedProducts });
  } catch (error) {
    console.error('Error extracting menu:', error);
    res.status(500).json({ error: 'Falha ao processar a imagem do cardápio.', details: String(error) });
  }
});

app.post('/api/list-groups', async (req, res) => {
  const { sessionToken, erpUrl: rawErpUrl } = req.body;
  const erpUrl = (rawErpUrl || 'https://teste.pratikapdv.com').replace(/\/+$/, '');
  
  if (!sessionToken) {
    return res.status(400).json({ error: 'Inválido' });
  }

  try {
     const groupsRes = await axios.post(
          `${erpUrl}/produto/grupo/listar`,
          {},
          {
            headers: {
              'Accept': 'application/json, text/javascript, */*; q=0.01',
              'Accept-Encoding': 'gzip, deflate, br, zstd',
              'Accept-Language': 'pt-PT,pt;q=0.9,en-US;q=0.8,en;q=0.7',
              'Cookie': `SESSION=${sessionToken}`,
              'Origin': erpUrl,
              'Referer': `${erpUrl}/`,
              'Sec-Fetch-Dest': 'empty',
              'Sec-Fetch-Mode': 'cors',
              'Sec-Fetch-Site': 'same-origin',
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
              'X-Requested-With': 'XMLHttpRequest',
              'sec-ch-ua': '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"'
            },
            httpsAgent,
          }
    );
        
    let groupsList = Array.isArray(groupsRes.data) ? groupsRes.data : groupsRes.data?.aaData || groupsRes.data?.data || groupsRes.data;
    res.json({ groups: groupsList });
  } catch (error: any) {
     console.error('Error fetching groups from external list:', error?.message);
     if (error?.response?.status === 401) {
       return res.status(401).json({ error: 'unauthorized_session', details: 'O Token de Sessão fornecido expirou ou é inválido. Por favor, renovar o Token nas Configurações de Sessão.' });
     }
     res.status(500).json({ error: 'Groups list fail.', details: String(error?.message || error) });
  }
});

// Helper to robustly parse axios response data in case it comes as a Buffer or serialized JSON string
function parseResponseData(resData: any): any {
  if (!resData) return null;
  if (Buffer.isBuffer(resData)) {
    try {
      return JSON.parse(resData.toString('utf-8'));
    } catch (e) {
      return resData.toString('utf-8');
    }
  }
  if (typeof resData === 'string') {
    try {
      return JSON.parse(resData);
    } catch (e) {
      return resData;
    }
  }
  // If we have an object that contains type: 'Buffer' and data as array
  if (resData && resData.type === 'Buffer' && Array.isArray(resData.data)) {
    try {
      const buffer = Buffer.from(resData.data);
      return JSON.parse(buffer.toString('utf-8'));
    } catch (e) {
      console.warn('[parseResponseData] Failed to parse JSON from Buffer-like object structure:', e);
    }
  }
  return resData;
}

// Helper to fetch details of a variation group from the ERP
async function fetchVariationGroup(sessionToken: string, codigoOrName: string | number, erpUrl: string = 'https://teste.pratikapdv.com') {
  const cleanErpUrl = erpUrl.replace(/\/+$/, '');
  const headers = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'Cookie': `SESSION=${sessionToken}`,
    'Origin': cleanErpUrl,
    'Referer': `${cleanErpUrl}/`,
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest'
  };

  try {
    let resolvedId: number | null = null;

    if (typeof codigoOrName === 'number' || (typeof codigoOrName === 'string' && !isNaN(Number(codigoOrName)) && codigoOrName.trim() !== '')) {
      resolvedId = Number(codigoOrName);
    } else {
      const listRes = await axios.post(
        `${cleanErpUrl}/variacao-grupo/listar`,
        {
          "Exibir": 250,
          "Pagina": 1,
          "OrdenarTipo": "DESC",
          "OrdenarPor": "CodigoVariacaoGrupo",
          "Buscar": "{}"
        },
        { headers, httpsAgent }
      );
      
      const parsedListRes = parseResponseData(listRes.data);
      const groupsList = Array.isArray(parsedListRes) 
        ? parsedListRes 
        : parsedListRes?.aaData || parsedListRes?.data || parsedListRes;

      if (groupsList && Array.isArray(groupsList)) {
        let cleanSearch = String(codigoOrName).trim().toUpperCase();
        if (cleanSearch && !cleanSearch.startsWith('OPC -')) {
          cleanSearch = `OPC - ${cleanSearch}`;
        }
        const matched = groupsList.find((g: any) => {
          let bname = (g.Nome || "").trim().toUpperCase();
          if (bname && !bname.startsWith('OPC -')) {
            bname = `OPC - ${bname}`;
          }
          return bname === cleanSearch;
        });
        if (matched) {
          resolvedId = Number(matched.CodigoVariacaoGrupo || matched.id || matched.Codigo);
        }
      }
    }

    if (resolvedId) {
      console.log(`[fetchVariationGroup] Carregando detalhes do grupo ID #${resolvedId} via AJAX...`);
      const detailRes = await axios.post(
        `${cleanErpUrl}/pagina/variacao-grupo/cadastrar`,
        { "CodigoVariacaoGrupo": resolvedId },
        { headers: { ...headers, page: 'ajax' }, httpsAgent }
      );
      
      const parsedDetailRes = parseResponseData(detailRes.data);
      let parsedGroup = parsedDetailRes;
      
      if (parsedDetailRes && parsedDetailRes.data) {
        try {
          const html = Buffer.from(parsedDetailRes.data, 'base64').toString('utf-8');
          const jsonMatch = html.match(/<code[^>]*data-json="dadosVariacaoGrupo"[^>]*>([\s\S]*?)<\/code>/);
          if (jsonMatch) {
            let jsonText = jsonMatch[1].trim();
            if (jsonText.startsWith('ey')) {
              jsonText = Buffer.from(jsonText, 'base64').toString('utf-8');
            } else {
              jsonText = jsonText
                .replace(/&quot;/g, '"')
                .replace(/&apos;/g, "'")
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&amp;/g, '&');
            }
            parsedGroup = JSON.parse(jsonText);
            console.log(`[fetchVariationGroup] Decodificado e extraído JSON de variações do grupo ${resolvedId} com sucesso.`);
          }
        } catch (parseErr: any) {
          console.error('[fetchVariationGroup] Erro ao decodificar Base64 ou fazer parse do JSON:', parseErr.message);
        }
      }
      return parsedGroup;
    }
  } catch (err: any) {
    console.error('[Helper] Error detail-fetching variation group:', err.message);
  }
  return null;
}

// Helper to map variations to the exact payload format required by the ERP
function mapListaVariacao(listaVariacao: any[]) {
  if (!Array.isArray(listaVariacao)) return [];
  return listaVariacao.map((item: any) => {
    const codVariacao = item.CodigoVariacao || item.Codigo || item.id || "";
    let codGroupVar = item.CodigoVariacaoGrupoVariacao || item.CodigoVariacaoGrupo_Variacao || item.CodigoVariacaoGrupoVariacaoCodigo || 0;
    return {
      "CodigoVariacaoGrupoVariacao": Number(codGroupVar) || 0,
      "CodigoVariacao": Number(codVariacao) || 0,
      "Nome": item.Nome || item.name || "",
      "Valor": item.Valor !== undefined ? Number(item.Valor) : (Number(item.ValorPadrao) || 0),
      "VariacaoDisponivelParaVenda": item.VariacaoDisponivelParaVenda !== false && item.Ativo !== false,
      "VariacaoAtivo": item.VariacaoAtivo !== false && item.Ativo !== false,
      "CodigoUsuario": item.CodigoUsuario || 2,
      "DataModificacao": item.DataModificacao || null,
      "ValorPadrao": item.ValorPadrao !== undefined ? Number(item.ValorPadrao) : (Number(item.Valor) || 0),
      "DisponivelParaVenda": item.DisponivelParaVenda !== false && item.Ativo !== false,
      "Ean": item.Ean || item.CodigoBarrasEan || ""
    };
  });
}

// Endpoint para sincronizar / criar grupo de variação de forma isolada
app.post('/api/sync-variation-group', async (req, res) => {
  const { sessionToken, variationGroupName, variations, erpUrl: rawErpUrl } = req.body;
  const erpUrl = (rawErpUrl || 'https://teste.pratikapdv.com').replace(/\/+$/, '');
  if (!sessionToken || !variationGroupName || !Array.isArray(variations)) {
    return res.status(400).json({ error: 'Parâmetros inválidos' });
  }

  try {
    const headers = {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'Cookie': `SESSION=${sessionToken}`,
      'Origin': erpUrl,
      'Referer': `${erpUrl}/`,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest'
    };

    let codigoVariacaoGrupo = null;
    let nomeGrupoVariavel = variationGroupName.trim().toUpperCase();
    if (nomeGrupoVariavel && !nomeGrupoVariavel.startsWith('OPC -')) {
      nomeGrupoVariavel = `OPC - ${nomeGrupoVariavel}`;
    }

    // 1. Tenta buscar se o grupo já existe com esse nome para RECUPERAR e REAPROVEITAR ele
    try {
      const listVgRes = await axios.post(
        `${erpUrl}/variacao-grupo/listar`,
        {
          "Exibir": 200,
          "Pagina": 1,
          "OrdenarTipo": "DESC",
          "OrdenarPor": "CodigoVariacaoGrupo",
          "Buscar": "{}"
        },
        { headers, httpsAgent }
      );
      
      const groupsList = Array.isArray(listVgRes.data) 
        ? listVgRes.data 
        : listVgRes.data?.aaData || listVgRes.data?.data || listVgRes.data;

      if (groupsList && Array.isArray(groupsList)) {
        const found = groupsList.find((g: any) => g.Nome && g.Nome.trim().toUpperCase() === nomeGrupoVariavel);
        if (found) {
          codigoVariacaoGrupo = found.CodigoVariacaoGrupo || found.id || found.Codigo;
          console.log(`[INDIVIDUAL-REUSO] Grupo de variação existente encontrado: "${nomeGrupoVariavel}" correspondente ao ID ${codigoVariacaoGrupo}.`);
        }
      }
    } catch (e: any) {
      console.error('Falha ao listar grupos de variação para reuso:', e.message);
    }

    // 2. Caso NÃO encontre o grupo cadastrado, cria as variações e o grupo
    if (!codigoVariacaoGrupo) {
      console.log(`[INDIVIDUAL-CRIAR] Grupo de variação "${nomeGrupoVariavel}" não encontrado. Criando novas variações...`);
      const listaVariacao = [];
      for (const v of variations) {
        try {
          await axios.post(
            `${erpUrl}/pagina/variacao/cadastrar`,
            {},
            { headers: { ...headers, page: 'ajax' }, httpsAgent }
          );

          const varRes = await axios.post(
            `${erpUrl}/variacao/incluiroualterar`,
            {
              "Nome": v.name,
              "Valor": v.price,
              "Detalhamento": "",
              "CodigoArquivo": null,
              "produtoGrupos": [],
              "ListaVariacaoProdutoGrupo": []
            },
            { headers, httpsAgent }
          );

          let codigoVariacao = varRes.data?.CodigoVariacao || varRes.data?.id || varRes.data?.Codigo;

          listaVariacao.push({
            "CodigoVariacao": codigoVariacao || "", 
            "Nome": v.name,
            "Valor": v.price,
            "Detalhamento": "",
            "Ativo": 1
          });
        } catch(err: any) {
          console.error('Falha ao criar variacao individual', v.name, err?.response?.data || err.message);
        }
      }

      if (listaVariacao.length > 0) {
        try {
          await axios.post(
            `${erpUrl}/pagina/variacao-grupo/cadastrar`,
            {},
            { headers: { ...headers, page: 'ajax' }, httpsAgent }
          );

          const vgRes = await axios.post(
            `${erpUrl}/variacao-grupo`,
            {
              "Nome": nomeGrupoVariavel,
              "Texto": "ESCOLHA SUA OPÇÃO",
              "QuantidadeMinima": 1,
              "QuantidadeMaxima": 1,
              "Tipo": "UmaOpcao",
              "ExibirMinimizado": false,
              "ExibirQuantidadeNome": false,
              "ListaVariacao": listaVariacao,
              "AtualizarProdutos": false
            },
            { headers, httpsAgent }
          );

          codigoVariacaoGrupo = vgRes.data?.CodigoVariacaoGrupo || vgRes.data?.id || vgRes.data?.Codigo;

          // Se não voltou ID no response, tenta buscar de novo para pegar
          if (!codigoVariacaoGrupo) {
            const listVgRes = await axios.post(
              `${erpUrl}/variacao-grupo/listar`,
              {
                "Exibir": 100,
                "Pagina": 1,
                "OrdenarTipo": "DESC",
                "OrdenarPor": "CodigoVariacaoGrupo",
                "Buscar": "{}"
              },
              { headers, httpsAgent }
            );
            
            const groupsList = Array.isArray(listVgRes.data) ? listVgRes.data : listVgRes.data?.aaData || listVgRes.data?.data || listVgRes.data;
            if (groupsList && Array.isArray(groupsList)) {
               const found = groupsList.find((g: any) => g.Nome && g.Nome.trim().toUpperCase() === nomeGrupoVariavel);
               if (found) {
                  codigoVariacaoGrupo = found.CodigoVariacaoGrupo || found.id || found.Codigo;
               }
            }
          }
        } catch(err: any) {
          console.error('Falha ao criar grupo de variações individual', err?.response?.data || err.message);
          return res.status(500).json({ error: 'Falha ao criar grupo de variações', details: err?.message });
        }
      }
    }

    if (codigoVariacaoGrupo) {
      return res.json({ success: true, codigoVariacaoGrupo });
    } else {
      return res.status(500).json({ error: 'Não foi possível cadastrar ou recuperar o grupo de variação.' });
    }
  } catch (error: any) {
    console.error('Erro no endpoint de grupo de variação:', error);
    return res.status(500).json({ error: 'Erro inesperado', details: error.message });
  }
});

let isGeminiSuspended = false;
let geminiSuspensionTime = 0;

// High-quality gourmet Unsplash images categorized for professional food/beverage delivery presentation
const PREMIUM_UNSPLASH_MAPPING: Record<string, string[]> = {
  'arroz': [
    'https://images.unsplash.com/photo-1536304997881-a372c179924b?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1516685018646-549198525c1b?w=600&auto=format&fit=crop&q=80'
  ],
  'feijao': [
    'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&auto=format&fit=crop&q=80'
  ],
  'feijoada': [
    'https://images.unsplash.com/photo-1551462147-ff29053bfc14?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1543353071-873f17a7a088?w=600&auto=format&fit=crop&q=80'
  ],
  'carne': [
    'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1603048588665-791ca8aea617?w=600&auto=format&fit=crop&q=80'
  ],
  'bife': [
    'https://images.unsplash.com/photo-1544025162-d76694265947?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1558030006-450675393462?w=600&auto=format&fit=crop&q=80'
  ],
  'grelhado': [
    'https://images.unsplash.com/photo-1624462966581-bc6d768cbce5?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?w=600&auto=format&fit=crop&q=80'
  ],
  'frango': [
    'https://images.unsplash.com/photo-1604908176997-125f25cc6f3d?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1598908314732-07113901949e?w=600&auto=format&fit=crop&q=80'
  ],
  'peixe': [
    'https://images.unsplash.com/photo-1519708227418-c8fd9a32b7a2?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1534604973900-c43ab4c2e0ab?w=600&auto=format&fit=crop&q=80'
  ],
  'lasanha': [
    'https://images.unsplash.com/photo-1574894709920-11b28e7367e3?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1619895092538-128341789043?w=600&auto=format&fit=crop&q=80'
  ],
  'macarrao': [
    'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=600&auto=format&fit=crop&q=80'
  ],
  'pasta': [
    'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=600&auto=format&fit=crop&q=80'
  ],
  'espaguete': [
    'https://images.unsplash.com/photo-1563379091339-03b21ab4a4f8?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1551183053-bf91a1d81141?w=600&auto=format&fit=crop&q=80'
  ],
  'pizza': [
    'https://images.unsplash.com/photo-1513104890138-7c749659a591?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1590947132387-155cc02f3212?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1574071318508-1cdbab80d00a?w=600&auto=format&fit=crop&q=80'
  ],
  'hamburguer': [
    'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1550547660-d9450f859349?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1586190848861-99aa4a171e90?w=600&auto=format&fit=crop&q=80'
  ],
  'burger': [
    'https://images.unsplash.com/photo-1568901346375-23c9450c58cd?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1550547660-d9450f859349?w=600&auto=format&fit=crop&q=80'
  ],
  'batata': [
    'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1630384060421-cb20d0e0649d?w=600&auto=format&fit=crop&q=80'
  ],
  'fritas': [
    'https://images.unsplash.com/photo-1573080496219-bb080dd4f877?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1630384060421-cb20d0e0649d?w=600&auto=format&fit=crop&q=80'
  ],
  'mussarela': [
    'https://images.unsplash.com/photo-1528256846573-049079aa9a23?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=600&auto=format&fit=crop&q=80'
  ],
  'queijo': [
    'https://images.unsplash.com/photo-1486297678162-eb2a19b0a32d?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1528256846573-049079aa9a23?w=600&auto=format&fit=crop&q=80'
  ],
  'calabresa': [
    'https://images.unsplash.com/photo-1532246429119-c22511db00d7?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1624462966581-bc6d768cbce5?w=600&auto=format&fit=crop&q=80'
  ],
  'salada': [
    'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1540420773420-3366772f4999?w=600&auto=format&fit=crop&q=80'
  ],
  'suco': [
    'https://images.unsplash.com/photo-1621506289937-a8e4df240d0b?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1613478223719-2ab802602423?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1600271886742-f049cd451bba?w=600&auto=format&fit=crop&q=80'
  ],
  'refrigerante': [
    'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1543258103-a62bdc069871?w=600&auto=format&fit=crop&q=80'
  ],
  'coca': [
    'https://images.unsplash.com/photo-1622483767028-3f66f32aef97?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1554866585-cd94860890b7?w=600&auto=format&fit=crop&q=80'
  ],
  'cerveja': [
    'https://images.unsplash.com/photo-1538251393170-a31d04499b92?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1566633806327-68e152aaf26d?w=600&auto=format&fit=crop&q=80'
  ],
  'chopp': [
    'https://images.unsplash.com/photo-1538251393170-a31d04499b92?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1566633806327-68e152aaf26d?w=600&auto=format&fit=crop&q=80'
  ],
  'agua': [
    'https://images.unsplash.com/photo-1548839140-29a749e1cf4d?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1508817628294-5a453fa0b8fb?w=600&auto=format&fit=crop&q=80'
  ],
  'bolo': [
    'https://images.unsplash.com/photo-1578985545062-69928b1d9587?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1535141192574-5d4897c13636?w=600&auto=format&fit=crop&q=80'
  ],
  'sorvete': [
    'https://images.unsplash.com/photo-1501443762814-0b1c536dbb6d?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1563805042-7684c019e1cb?w=600&auto=format&fit=crop&q=80'
  ],
  'acai': [
    'https://images.unsplash.com/photo-1590301157890-4810ed352733?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1589533610905-2d5c22d39aa4?w=600&auto=format&fit=crop&q=80'
  ],
  'pastel': [
    'https://images.unsplash.com/photo-1585325701165-351af916e5ec?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1613769049987-b21ee3296098?w=600&auto=format&fit=crop&q=80'
  ],
  'salgado': [
    'https://images.unsplash.com/photo-1585325701165-351af916e5ec?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1613769049987-b21ee3296098?w=600&auto=format&fit=crop&q=80'
  ],
  'caldo': [
    'https://images.unsplash.com/photo-1547592165-e1d17fed6005?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1541832676-9b763b0239ab?w=600&auto=format&fit=crop&q=80'
  ],
  'sopa': [
    'https://images.unsplash.com/photo-1547592165-e1d17fed6005?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1541832676-9b763b0239ab?w=600&auto=format&fit=crop&q=80'
  ],
  'pudim': [
    'https://images.unsplash.com/photo-1528975604071-b4daaf306dc5?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1488477181946-6428a0291777?w=600&auto=format&fit=crop&q=80'
  ],
  'torta': [
    'https://images.unsplash.com/photo-1519869325930-281384150729?w=600&auto=format&fit=crop&q=80',
    'https://images.unsplash.com/photo-1509440159596-0249088772ff?w=600&auto=format&fit=crop&q=80'
  ]
};

function getLocalOptimizedSearchTerms(productName: string): { cleanPortugueseQuery: string; cleanEnglishQuery: string; itemType: string } {
  let name = productName.trim();
  let clean = name.toUpperCase();

  // Remove common prefixes, abbreviations, indicators (like "AT.", "PROMO.", "CD.", "UNI.", "FUT.")
  clean = clean.replace(/^(AT\.|PROMO\.|FUT\.|REF\.|CD\.|UNI\.)\s+/g, '');

  // Remove portion bounds, weights and indicators (e.g. 1KG, 200G, 350ML, 2L, 50G, 100 GR, 500 GR, 1 UN, 2 LITROS, etc.)
  clean = clean.replace(/\d+\s*(KG|G|ML|L|GR|UN|UNIDADE|UNIDADES|PCT|PCTS|LT|LTA|LTAS|LITRO|LITROS|GRS|GRAMAS|MLS)\b/gi, '');
  
  // Remove volume indicators as freestanding words
  clean = clean.replace(/\b(KG|ML|UN|UNID|PCT|LT|LTA|LITROS|LITRO|GRAMAS|GR)\b/gi, '');

  // Remove specials, symbols, barcodes and layout noise
  clean = clean.replace(/[()\[\]\-\/\\_*+]/g, ' ');
  clean = clean.replace(/\d{6,14}\b/g, ''); // strip random long sequences of EAN/barcodes
  clean = clean.replace(/\s+/g, ' ').trim();

  const ptQuery = clean.toLowerCase();

  // Fine-tuned visual categorizer
  let itemType = 'food';
  const lowercaseName = ptQuery;
  const beverageKeywords = [
    'suco', 'refrigerante', 'refri', 'cerveja', 'agua', 'água', 'chá', 'cha', 'fanta', 'coca', 'guarana', 
    'guaraná', 'sprite', 'pepsi', 'chpp', 'chopp', 'vinho', 'borda', 'red bull', 'energy', 'bebida', 'tubaína',
    'skol', 'brahma', 'heineken', 'long neck', 'lata', 'garrafa', 'schin', 'itubaína', 'energético'
  ];
  const dessertKeywords = [
    'bolo', 'sorvete', 'pudim', 'chocolate', 'doce', 'torta', 'mousse', 'açai', 'açaí', 'sobremesa', 
    'gelado', 'picolé', 'picole', 'petit', 'gateau', 'brownie', 'doce', 'brigadeiro', 'beijinho', 'bombom'
  ];
  const ingredientKeywords = [
    'cebola', 'alho', 'óleo', 'oleo', 'sal', 'farinha', 'azeite', 'limão', 'limao', 'molho', 'vinagre',
    'molho ingles', 'maionese', 'salpeito', 'orégano', 'tempero', 'ketchup', 'mostarda'
  ];

  if (beverageKeywords.some(kw => lowercaseName.includes(kw))) {
    itemType = 'beverage';
  } else if (dessertKeywords.some(kw => lowercaseName.includes(kw))) {
    itemType = 'dessert';
  } else if (ingredientKeywords.some(kw => lowercaseName.includes(kw))) {
    itemType = 'ingredient';
  }

  // Expanded culinary dictionary for high quality search indexing on global engines
  let enQuery = ptQuery;
  const translations: Record<string, string> = {
    'arroz': 'steamed rice',
    'feijao': 'savory beans',
    'feijão': 'savory beans',
    'carne': 'grilled meat beef steak',
    'bife': 'beef steak',
    'frango': 'roasted chicken',
    'grelhado': 'grilled meat platters',
    'peixe': 'cooked fish dish',
    'lasanha': 'cheese lasagna baked',
    'batata': 'potato fries',
    'mandioca': 'fried yuca cassava',
    'salada': 'fresh salad',
    'alface': 'lettuce',
    'tomate': 'tomato',
    'ovo': 'egg',
    'molho': 'gourmet sauce coating',
    'queijo': 'sliced cheese gourmet',
    'presunto': 'sliced ham',
    'pão': 'bread loaf roll',
    'pao': 'bread loaf roll',
    'refrigerante': 'chilled soda soft drink',
    'refri': 'chilled soda soft drink',
    'suco': 'natural fresh fruit juice',
    'agua': 'cold mineral water glass',
    'água': 'cold mineral water glass',
    'cerveja': 'cold draft beer mug',
    'chopp': 'cold draft beer mug',
    'bolo': 'sweet cake slice',
    'sorvete': 'ice cream cup scoop',
    'doce': 'gourmet sweet dessert pastry',
    'vinagrete': 'brazilian vinaigrette salad salsa',
    'caldo': 'hot soup broth soup bowl',
    'sopa': 'hot soup bowl',
    'mussarela': 'melted mozzarella cheese plate',
    'calabresa': 'grilled calabresa sausage pepperoni',
    'pizza': 'gourmet hot pizza slice',
    'hamburguer': 'gourmet bbq cheese burger',
    'burger': 'gourmet bbq cheese burgers',
    'pastel': 'brazilian fried pastry empanada',
    'salgado': 'brazilian bakery snacks appetizers',
    'strogonoff': 'creamy beef stroganoff dish',
    'parmegiana': 'crispy chicken parmigiana melted'
  };

  Object.keys(translations).forEach(ptWord => {
    const rx = new RegExp(`\\b${ptWord}\\b`, 'gi');
    if (rx.test(enQuery)) {
      enQuery = enQuery.replace(rx, translations[ptWord]);
    }
  });

  return {
    cleanPortugueseQuery: ptQuery || productName,
    cleanEnglishQuery: enQuery || ptQuery || productName,
    itemType
  };
}

// Helper to optimize image searching using Gemini to categorize and generate perfect search strings in Portuguese & English
async function getOptimizedSearchTerms(productName: string): Promise<{ cleanPortugueseQuery: string; cleanEnglishQuery: string; itemType: string }> {
  const now = Date.now();
  if (isGeminiSuspended && (now - geminiSuspensionTime < 10 * 60 * 1000)) {
    console.log(`[IMAGE-PREPROCESS] Gemini está temporariamente em modo de suspensão por limite de cota. Retornando termos locais simplificados: "${productName}"`);
    return getLocalOptimizedSearchTerms(productName);
  }

  try {
    const promptText = `Analyze the product named "${productName}". To search high-quality, professional food or retail stock photography for a food delivery app, we need optimized, simplified search terms.
Provide a JSON response with:
- "cleanPortugueseQuery": A clean, descriptive search query in Portuguese, focusing purely on the visual food plate or item itself, omitting portion sizes (like 1kg, 200g, 350ml, etc.), numbers, barcodes, and NCM codes. Focus on taste/appearance (e.g. "Arroz branco soltinho gourmet", "Feijoada brasileira completa", "Feijão tropeiro mineiro gourmet prato").
- "cleanEnglishQuery": A highly descriptive, delicious-sounding English translated query for international food photography indices (e.g., "steamed white rice gourmet", "brazilian feijoada dish plate", "brazilian tropeiro beans savory platter").
- "itemType": The visual category: "food" (for cooked dishes/meals), "beverage" (soda, beer, juice), "dessert" (cakes, sweets), "ingredient" (onions, raw rice), or "general".

Return ONLY a valid JSON object matching the schema. No markdown formatting or decoration.`;

    const response = await generateContentWithFallback({
      contents: promptText,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            cleanPortugueseQuery: { type: Type.STRING },
            cleanEnglishQuery: { type: Type.STRING },
            itemType: { type: Type.STRING }
          },
          required: ["cleanPortugueseQuery", "cleanEnglishQuery", "itemType"]
        }
      }
    });

    const text = response.text || '';
    return JSON.parse(text);
  } catch (err: any) {
    console.warn('[IMAGE-PREPROCESS] Falha ao processar nome do produto com Gemini:', err.message || err);
    
    // Activating circuit breaker for quota/rate limit exceeds
    const errMsg = String(err.message || '').toLowerCase();
    if (errMsg.includes('429') || errMsg.includes('limit') || errMsg.includes('quota') || errMsg.includes('exhausted') || errMsg.includes('resource_exhausted') || errMsg.includes('503')) {
      console.warn('[IMAGE-PREPROCESS] Detectado esgotamento de quota ou indisponibilidade no Gemini API. Ativando circuito de suspensão por 10 minutos.');
      isGeminiSuspended = true;
      geminiSuspensionTime = Date.now();
    }

    // Safe standard fallback using local optimizer
    return getLocalOptimizedSearchTerms(productName);
  }
}

// Global fetcher leveraging optimized queries, concurrent multi-term searches, and high-quality filtering
async function fetchHighQualityProductImageUrls(productName: string): Promise<string[]> {
  const terms = await getOptimizedSearchTerms(productName);
  console.log(`[OPTIMIZED-SEARCH] Termos sugeridos para "${productName}":`, terms);

  // We will search both optimized Portuguese and English combinations
  const searchQueries = [
    terms.cleanPortugueseQuery,
    terms.cleanEnglishQuery,
  ];

  if (terms.itemType === 'food' || terms.itemType === 'dessert') {
    searchQueries[0] += ' comida restaurante prato gourmet';
    searchQueries[1] += ' food dish commercial photography close up';
  } else if (terms.itemType === 'beverage') {
    searchQueries[0] += ' bebida copo refrescante';
    searchQueries[1] += ' cold beverage soft drink premium photography';
  }

  const finalUrls: string[] = [];
  const processedSet = new Set<string>();

  // Integrate Premium Unsplash Mapped Images right away!
  // This guarantees spectacular high-def foodie visuals immediately available
  const lowercaseName = productName.toLowerCase();
  Object.keys(PREMIUM_UNSPLASH_MAPPING).forEach(kw => {
    if (lowercaseName.includes(kw) || terms.cleanPortugueseQuery.toLowerCase().includes(kw)) {
      const matchUrls = PREMIUM_UNSPLASH_MAPPING[kw];
      matchUrls.forEach(mUrl => {
        if (!processedSet.has(mUrl)) {
          processedSet.add(mUrl);
          finalUrls.push(mUrl);
        }
      });
    }
  });

  try {
    // Run Google image query in parallel-controlled or fallbacked way
    const results = await Promise.allSettled(
      searchQueries.map(async (query) => {
        try {
          console.log(`[IMAGE-SEARCH] Buscando no Google Images para: "${query}"`);
          const imgList = await google.image(query, { safe: false });
          return imgList || [];
        } catch (e: any) {
          console.warn(`[IMAGE-SEARCH] Falha na busca por "${query}":`, e.message);
          return [];
        }
      })
    );

    const rawImagesList: any[] = [];
    results.forEach((res) => {
      if (res.status === 'fulfilled' && res.value) {
        rawImagesList.push(...res.value);
      }
    });

    // Penalize and filter known sites with intrusive watermarks, bad previews, or strict anti-hotlink blocks (403 errors)
    const blacklistedDomains = [
      'pinterest.com', 'pin.it',
      'shutterstock.com', 'alamy.com', 'gettyimages.com', 'depositphotos.com',
      'dreamstime.com', 'freeimages.com', 'istockphoto.com', '123rf.com',
      'canstockphoto.com', 'vectorstock.com', 'wixstatic.com',
      'facebook.com', 'instagram.com', 'shopee.com', 'mercadolivre.com', 'mercadolibre.com',
      'casasbahia.com', 'magazineluiza.com', 'aliimg.com', 'aliexpress.com', 'marianas.com',
      'globalsources.com', 'freepik.com', 'yelpcdn.com', 'blogspot.com', 'wordpress.com',
      'bstatic.com', 'booking.com', 'agoda.net', 'enjoei.com.br', 'olx.com.br',
      'tiktok.com', 'vecteezy.com', 'panelinha.com.br'
    ];

    for (const img of rawImagesList) {
      if (!img || !img.url) continue;
      const url = img.url;

      // Ensure proper structure and strip low-resolution, base64 or raw local temporary assets
      if (!url.startsWith('http') || url.includes('x-raw-image') || url.length > 350) continue;
      
      // Blacklist filter checker
      const hasBlacklistedDomain = blacklistedDomains.some(domain => url.toLowerCase().includes(domain));
      if (hasBlacklistedDomain) continue;

      // Unique additions to maintain highly relevant results
      if (!processedSet.has(url)) {
        processedSet.add(url);
        finalUrls.push(url);
      }
    }

  } catch (error: any) {
    console.error(`[IMAGE-FETCH-FAIL] Falha ao processar buscas de imagens para "${productName}":`, error.message);
  }

  // Fallback to beautiful, hotlinking-friendly generic unsplash links if there's a scarcity of elements
  if (finalUrls.length < 5) {
    console.log(`[FALLBACK] Imagens de busca insuficientes encontradas (${finalUrls.length}). Adicionando backups do Unsplash...`);
    const genericBackups = [
      'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1543353071-873f17a7a088?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1504674900247-0877df9cc836?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1476224203421-9ac39bcb3327?w=600&auto=format&fit=crop&q=80',
      'https://images.unsplash.com/photo-1482049016688-2d3e1b311543?w=600&auto=format&fit=crop&q=80'
    ];

    for (const fbUrl of genericBackups) {
      if (finalUrls.length >= 8) break;
      if (!processedSet.has(fbUrl)) {
        processedSet.add(fbUrl);
        finalUrls.push(fbUrl);
      }
    }
  }

  // Slice maximum 8 highly appealing candidates
  return finalUrls.slice(0, 8);
}

// Sync endpoint
app.post('/api/search-product-images', async (req, res) => {
  const { name } = req.body;
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Falta o nome do produto para buscar imagens.' });
  }

  try {
    console.log(`[SEARCH-IMAGES] Buscando sugestões de imagem de alta qualidade para: "${name}"...`);
    const filteredUrls = await fetchHighQualityProductImageUrls(name);
    return res.json({ success: true, imageUrls: filteredUrls });
  } catch (error: any) {
    console.error('Erro ao buscar imagens:', error.message || error);
    const fallbackUrls = [
      `https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=500`,
      `https://images.unsplash.com/photo-1498837167922-ddd27525d352?w=500`,
      `https://images.unsplash.com/photo-1565299624946-b28f40a0ae38?w=500`,
      `https://images.unsplash.com/photo-1543353071-873f17a7a088?w=500`
    ];
    return res.json({ success: true, imageUrls: fallbackUrls, isFallback: true, apiError: "rate_limit_or_error" });
  }
});

// Sync endpoint
app.post('/api/sync-products', async (req, res) => {
  const { sessionToken, products, erpUrl: rawErpUrl } = req.body;
  const erpUrl = (rawErpUrl || 'https://teste.pratikapdv.com').replace(/\/+$/, '');
  if (!sessionToken || !Array.isArray(products)) {
    return res.status(400).json({ error: 'Inválido' });
  }

  const results = [];
  // Cache to store resolved variation group variationGroupName -> codigoVariacaoGrupo
  const localGroupCache: Record<string, any> = {};
  
  for (const product of products) {
    try {
      const headers = {
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Cookie': `SESSION=${sessionToken}`,
        'Origin': erpUrl,
        'Referer': `${erpUrl}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
        'X-Requested-With': 'XMLHttpRequest'
      };

      // Dynamically search and find product image if available
      let codigoArquivoTemporario = "";
      
      let candidateUrls: string[] = [];
      if (product.imageUrl && product.imageUrl.startsWith('http')) {
        candidateUrls.push(product.imageUrl);
      } else {
        try {
          console.log(`[SYNC-PRODUCTS] Nenhuma imagem pré-selecionada. Buscando com IA de Imagens para: "${product.name}"...`);
          candidateUrls = await fetchHighQualityProductImageUrls(product.name);
        } catch (searchErr: any) {
          console.log(`[SYNC-PRODUCTS] Falha na busca por imagens para "${product.name}":`, searchErr.message);
        }
      }

      // Safe multi-candidate downloader retry loop
      for (const imageUrlStr of candidateUrls) {
        if (!imageUrlStr || !imageUrlStr.startsWith('http')) continue;
        try {
          console.log(`[SYNC-PRODUCTS] Tentando baixar imagem candidata para "${product.name}": ${imageUrlStr}`);
          const imgFetchRes = await axios.get(imageUrlStr, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
              'Referer': 'https://www.google.com/',
            },
            httpsAgent,
            timeout: 5000
          });
          const imageBuffer = Buffer.from(imgFetchRes.data);
          
          if (imageBuffer && imageBuffer.length > 500) {
            console.log(`[SYNC-PRODUCTS] Download concluído com sucesso (${imageBuffer.length} bytes). Enviando foto temporária de cadastro ao ERP...`);
            const boundary = '----WebKitFormBoundarywsXwYWN4ch60vm2k';
            const headerPart = Buffer.from(
              `--${boundary}\r\n` +
              `Content-Disposition: form-data; name="Arquivo"; filename="product.jpg"\r\n` +
              `Content-Type: image/jpeg\r\n\r\n`
            );
            const footerPart = Buffer.from(`\r\n--${boundary}--\r\n`);
            const payload = Buffer.concat([headerPart, imageBuffer, footerPart]);

            const uploadRes = await axios.post(
              `${erpUrl}/produto/foto`,
              payload,
              {
                headers: {
                  ...headers,
                  'Content-Type': `multipart/form-data; boundary=${boundary}`
                },
                httpsAgent,
                timeout: 8000
              }
            );

            if (uploadRes.data && uploadRes.data.CodigoArquivoTemporario) {
              codigoArquivoTemporario = uploadRes.data.CodigoArquivoTemporario;
              console.log(`[SYNC-PRODUCTS] Foto de cadastro vinculada temporariamente com sucesso para "${product.name}". Token: ${codigoArquivoTemporario}`);
              break; // Succeeded! Stop trying remaining candidate images
            }
          }
        } catch (err: any) {
          console.log(`[SYNC-PRODUCTS] Falha de processamento na imagem candidato [${imageUrlStr}]:`, err.message);
        }
      }

      // 1. Abrir Modal de Cadastro Produto
      await axios.post(
        `${erpUrl}/pagina/produto/cadastrar`,
        {},
        { headers: { ...headers, page: 'ajax' }, httpsAgent }
      );

      // 2. Simular busca por código de barras antes do cadastro
      await axios.post(
        `${erpUrl}/produto/listarsimples`,
        { Buscar: `{"CodigoBarrasEan":"${product.barcode}"}` },
        { headers, httpsAgent }
      );
      
      // 3. Cadastrar o item/produto inicialmente SEM variações vinculadas
      const basePayload = {
        "CodigoBarrasEan": String(product.barcode),
        "Nome": product.name,
        "CodigoUnidadeMedida": "1",
        "QuantidadePorCaixa": 1,
        "Ncm": product.ncm || "",
        "CodigoProdutoGrupo": product.groupId || "1",
        "EstoqueAtual": "",
        "EstoqueMinimo": 0,
        "Visivel": 1,
        "CodigoArquivo": "",
        "CodigoArquivoTemporario": codigoArquivoTemporario,
        "GerarCodigoBarrasVariacaoAutomatico": 0,
        "CodigoVariacao": "2",
        "valorVariacao": 0,
        "CodigoBarra": "",
        "botaoAdicionarVariacao": "ADICIONAR",
        "QuantidadeMinimaVariacao": 1,
        "QuantidadeVariacao": 1,
        "MaxValorVariacao": 0,
        "QtdeVariacaoVenda": 0,
        "VariacaoUnica": 0,
        "CodigoVariacaoGrupo": "",
        "AdicionarGrupo": "ADICIONAR",
        "uTrib": "",
        "RegraFiscalProduto-1": "",
        "RegraFiscalProduto-2": "",
        "RegraFiscalProduto-3": "",
        "RegraFiscalProduto-4": "",
        "RegraFiscalProduto-5": "",
        "RegraFiscalProduto-6": "",
        "RegraFiscalProduto-7": "",
        "Observacao": "",
        "Acrescimo": 0,
        "MateriaPrima": 0,
        "CodigoFabricante": "",
        "PesoLiquido": 0,
        "PesoBruto": 0,
        "Volume": 0,
        "Especie": "",
        "Pesavel": 0,
        "PermiteAlterarDescricaoVenda": 0,
        "PermiteAlterarPrecoUnitarioVenda": 0,
        "IncideTaxaServico": 1,
        "AlertaQuantidadeEstoque": 1,
        "PermiteAcrescimo": 0,
        "AcrescimoAuto": 0,
        "precoTipoAcrescimo": "1",
        "inserirTodosAcrescimos": "Inserir todos os PRODUTOS ADICIONAIS",
        "CodigoProdutoAcrescimo": "",
        "precoAcrescimo": 0,
        "botaoAdicionarAcrescimo": "+",
        "AcrescimoUnico": 0,
        "Combo": 0,
        "ComboAgruparVisualizacao": 0,
        "CodigoProdutoCombo": "",
        "ValorCustoCombo": "R$ 0,00",
        "ProdutoPrecoTipoCombo": "1",
        "ValorUnitarioCombo": "R$ 0,00",
        "QuantidadeCombo": "1,000",
        "ValorTotalCombo": "R$ 0,00",
        "botaoAdicionarCombo": "+",
        "TotalCustoCombo": "R$ 0,00",
        "TotalLucroCombo": "R$ 0,00",
        "TotalCombo": "R$ 0,00",
        "CodigoProdutoMateriaPrima": "",
        "quantidadeMateriaPrima": "0,00000",
        "botaoAdicionarMateriaPrima": "Adicionar",
        "ProdutoReceitaCustoTotal": "R$ 0,00",
        "RendimentoReceita": 1,
        "CustoUnitarioReceita": 0,
        "PromocaoNome": "",
        "DiasSemana": "Segunda,Terca,Quarta,Quinta,Sexta,Sabado,Domingo",
        "PromocaoDataInicial": "2026-05-01",
        "PromocaoDataFinal": "2026-05-31",
        "PromocaoHoraInicial": "00:00",
        "PromocaoHoraFinal": "23:59",
        "PromocaoListaProdutoPrecoTipo": "3",
        "PromocaoTipo": "ValorFixo",
        "PromocaoValor": "R$ 0,00",
        "PromocaoAPartir": 1,
        "PromocaoAte": null,
        "botaoAdicionarPromocao": "INCLUIR",
        "sugestaoCadastrar": "Nova Sugestão",
        "ListaPreco": [{ "CodigoProdutoPrecoTipo": 1, "Valor": product.price }],
        "Receita": [],
        "ListaProdutoAcrescimo": [],
        "descricaoUnidadeMedida": "UNI",
        "Variacoes": [],
        "Promocoes": [],
        "ListaVariacaoGrupo": [], // Inicialmente nenhum grupo vinculado no cadastro inicial
        "ListaProdutoSugestao": [],
        "DuplicandoProduto": false,
        "ListaProdutoCombo": [],
        "PersonalizarTributacao": true,
        "ListaRegraFiscalProduto": []
      };

      const saveRes = await axios.post(
        `${erpUrl}/produto`,
        basePayload,
        { headers, httpsAgent }
      );
      
      let createdProductId = null;
      if (saveRes.data && saveRes.data.CodigoProduto) {
        createdProductId = saveRes.data.CodigoProduto;
      }
      
      // Se não voltou ID direto no response, vamos tentar buscar pelo código de barras/nome
      if (!createdProductId) {
         try {
             const searchObj: any = {};
             if (product.barcode && String(product.barcode).trim() !== '' && String(product.barcode).trim().toLowerCase() !== 'null') {
                searchObj.CodigoBarrasEan = String(product.barcode);
             } else {
                searchObj.Nome = String(product.name);
             }
             const listReqBody = { Buscar: JSON.stringify(searchObj) };
             const listRes = await axios.post(
               `${erpUrl}/produto/listarsimples`,
               listReqBody,
               { headers, httpsAgent }
             );
             
             if (listRes.data?.data && listRes.data.data.length > 0) {
               createdProductId = listRes.data.data[0].CodigoProduto;
             } else if (Array.isArray(listRes.data) && listRes.data.length > 0) {
                 createdProductId = listRes.data[0].CodigoProduto;
             }
         } catch(e: any) {
             console.error("Erro ao listar produto para descobrir ID", e.message);
         }
      }

      console.log(`[SYNC-PRODUCTS] Produto "${product.name}" cadastrado. ID detectado: ${createdProductId}`);

      // 4. Depois cadastrar/reutilizar o grupo de variação se o produto possuir variações
      let codigoVariacaoGrupo = product.variationGroupId || product.CodigoVariacaoGrupo || null;

      if (createdProductId && (codigoVariacaoGrupo || (product.variations && product.variations.length > 0))) {
        let nomeGrupoVariavel = (product.variationGroupName || `OPC - ${product.name.substring(0, 20)}`).trim().toUpperCase();
        if (nomeGrupoVariavel && !nomeGrupoVariavel.startsWith('OPC -')) {
          nomeGrupoVariavel = `OPC - ${nomeGrupoVariavel}`;
        }
        
        const cacheKey = nomeGrupoVariavel.trim().toUpperCase();

        if (localGroupCache[cacheKey]) {
          codigoVariacaoGrupo = localGroupCache[cacheKey];
          console.log(`[CACHE-REUSO] Grupo de variação reutilizado da memória: "${nomeGrupoVariavel}" para o produto ${product.name}. ID: ${codigoVariacaoGrupo}`);
        } else {
          // Busca no ERP para verificar se já existe
          try {
            const listVgRes = await axios.post(
              `${erpUrl}/variacao-grupo/listar`,
              {
                "Exibir": 200,
                "Pagina": 1,
                "OrdenarTipo": "DESC",
                "OrdenarPor": "CodigoVariacaoGrupo",
                "Buscar": "{}"
              },
              { headers, httpsAgent }
            );
            
            const groupsList = Array.isArray(listVgRes.data) 
              ? listVgRes.data 
              : listVgRes.data?.aaData || listVgRes.data?.data || listVgRes.data;

            if (groupsList && Array.isArray(groupsList)) {
              let cleanSearch = nomeGrupoVariavel.trim().toUpperCase();
              const found = groupsList.find((g: any) => {
                let bname = (g.Nome || "").trim().toUpperCase();
                if (bname && !bname.startsWith('OPC -')) {
                  bname = `OPC - ${bname}`;
                }
                return bname === cleanSearch;
              });
              
              if (found) {
                codigoVariacaoGrupo = found.CodigoVariacaoGrupo || found.id || found.Codigo;
                console.log(`[REUSO] Grupo de variação encontrado no ERP: "${nomeGrupoVariavel}" ID ${codigoVariacaoGrupo}.`);
                localGroupCache[cacheKey] = codigoVariacaoGrupo;
              }
            }
          } catch (e: any) {
            console.error('Falha ao listar grupos para reuso:', e.message);
          }

          // Se não encontrou, cria as variações individuais e depois o grupo de variação
          if (!codigoVariacaoGrupo) {
            console.log(`[CRIAR] Criando variações para o grupo "${nomeGrupoVariavel}"...`);
            const listaVariacao = [];
            for (const v of product.variations) {
              try {
                await axios.post(
                  `${erpUrl}/pagina/variacao/cadastrar`,
                  {},
                  { headers: { ...headers, page: 'ajax' }, httpsAgent }
                );

                const varRes = await axios.post(
                  `${erpUrl}/variacao/incluiroualterar`,
                  {
                    "Nome": v.name,
                    "Valor": v.price,
                    "Detalhamento": "",
                    "CodigoArquivo": null,
                    "produtoGrupos": [],
                    "ListaVariacaoProdutoGrupo": []
                  },
                  { headers, httpsAgent }
                );

                let codigoVariacao = varRes.data?.CodigoVariacao || varRes.data?.id || varRes.data?.Codigo;

                listaVariacao.push({
                  "CodigoVariacao": codigoVariacao || "", 
                  "Nome": v.name,
                  "Valor": v.price,
                  "Detalhamento": "",
                  "Ativo": 1
                });
              } catch(err: any) {
                console.error('Falha ao criar variação individual:', v.name, err.message);
              }
            }

            if (listaVariacao.length > 0) {
              try {
                await axios.post(
                  `${erpUrl}/pagina/variacao-grupo/cadastrar`,
                  {},
                  { headers: { ...headers, page: 'ajax' }, httpsAgent }
                );

                const vgRes = await axios.post(
                  `${erpUrl}/variacao-grupo`,
                  {
                    "Nome": nomeGrupoVariavel,
                    "Texto": "ESCOLHA SUA OPÇÃO",
                    "QuantidadeMinima": 1,
                    "QuantidadeMaxima": 1,
                    "Tipo": "UmaOpcao",
                    "ExibirMinimizado": false,
                    "ExibirQuantidadeNome": false,
                    "ListaVariacao": listaVariacao,
                    "AtualizarProdutos": false
                  },
                  { headers, httpsAgent }
                );

                codigoVariacaoGrupo = vgRes.data?.CodigoVariacaoGrupo || vgRes.data?.id || vgRes.data?.Codigo;

                if (!codigoVariacaoGrupo) {
                  // Busca rápida pelo nome caso o response não traga o ID
                  const listVgRes = await axios.post(
                    `${erpUrl}/variacao-grupo/listar`,
                    {
                      "Exibir": 100,
                      "Pagina": 1,
                      "OrdenarTipo": "DESC",
                      "OrdenarPor": "CodigoVariacaoGrupo",
                      "Buscar": "{}"
                    },
                    { headers, httpsAgent }
                  );
                  
                  const groupsList = Array.isArray(listVgRes.data) ? listVgRes.data : listVgRes.data?.aaData || listVgRes.data?.data || listVgRes.data;
                  if (groupsList && Array.isArray(groupsList)) {
                     let cleanSearch = nomeGrupoVariavel.trim().toUpperCase();
                     const found = groupsList.find((g: any) => {
                       let bname = (g.Nome || "").trim().toUpperCase();
                       if (bname && !bname.startsWith('OPC -')) {
                         bname = `OPC - ${bname}`;
                       }
                       return bname === cleanSearch;
                     });
                     if (found) {
                        codigoVariacaoGrupo = found.CodigoVariacaoGrupo || found.id || found.Codigo;
                     }
                  }
                }
              } catch(err: any) {
                console.error('Falha ao instanciar grupo de variação:', err.message);
              }
            }
          }
          
          if (codigoVariacaoGrupo) {
            localGroupCache[cacheKey] = codigoVariacaoGrupo;
          }
        }

        // Se conseguimos identificar ou registrar o grupo, enviar a requisição PUT de alteração do produto
        if (codigoVariacaoGrupo) {
          let resolvedListaVariacao: any[] = [];
          
          try {
            const resolvedGroup = await fetchVariationGroup(sessionToken, codigoVariacaoGrupo, erpUrl);
            console.log(`[SYNC-PRODUCTS] Detalhes recuperados do grupo ID ${codigoVariacaoGrupo}:`, JSON.stringify(resolvedGroup));
            
            if (resolvedGroup) {
              const variationsArray = resolvedGroup.ListaVariacaoGrupoVariacao || 
                                     resolvedGroup.ListaVariacao || 
                                     resolvedGroup.data?.ListaVariacaoGrupoVariacao || 
                                     resolvedGroup.data?.ListaVariacao || 
                                     resolvedGroup.variacoes || 
                                     resolvedGroup.Variacoes || 
                                     resolvedGroup.listaVariacao;
              
              if (variationsArray && Array.isArray(variationsArray)) {
                resolvedListaVariacao = mapListaVariacao(variationsArray);
                console.log(`[SYNC-PRODUCTS] Encontradas ${resolvedListaVariacao.length} variações estruturadas para o grupo ID ${codigoVariacaoGrupo}.`);
              } else {
                console.warn(`[SYNC-PRODUCTS] Grupo ID ${codigoVariacaoGrupo} retornado sem coleções de variações válidas.`);
              }
            } else {
              console.warn(`[SYNC-PRODUCTS] Grupo ID ${codigoVariacaoGrupo} não retornou nenhum daddo detalhado.`);
            }
          } catch (detailErr: any) {
            console.error(`[SYNC-PRODUCTS] Erro ao obter detalhes das variações do grupo ${codigoVariacaoGrupo}:`, detailErr.message);
          }

          // Executar pré-condição / simulação de cadastro como no log do usuário para inicializar a sessão se necessário
          try {
            console.log(`[SYNC-PRODUCTS] Chamando pré-condição/cadastro do grupo ID ${codigoVariacaoGrupo} via AJAX...`);
            await axios.post(
              `${erpUrl}/pagina/variacao-grupo/cadastrar`,
              { "CodigoVariacaoGrupo": Number(codigoVariacaoGrupo) },
              { headers: { ...headers, page: 'ajax' }, httpsAgent }
            );
          } catch (ajxErr: any) {
            console.warn(`[SYNC-PRODUCTS] Falha silenciosa na pré-condição do grupo ${codigoVariacaoGrupo}:`, ajxErr.message);
          }

          // 5. Envia o PUT de alteração para atrelar o grupo de variações ao produto de maneira limpa e autêntica
          console.log(`[SYNC-PRODUCTS] Associando grupo ID ${codigoVariacaoGrupo} ao produto ID ${createdProductId} via PUT...`);
          
          const putPayload: any = {
            ...basePayload,
            "CodigoProduto": Number(createdProductId),
            "CodigoVariacaoGrupo": String(codigoVariacaoGrupo),
            "AdicionarGrupo": "ADICIONAR"
          };

          if (resolvedListaVariacao && resolvedListaVariacao.length > 0) {
            putPayload.ListaVariacaoGrupo = [{ 
              "CodigoVariacaoGrupo": Number(codigoVariacaoGrupo), 
              "ListaVariacao": resolvedListaVariacao 
            }];
            console.log(`[SYNC-PRODUCTS] Enviando ${resolvedListaVariacao.length} variações vinculadas no grupo ID ${codigoVariacaoGrupo} para o produto #${createdProductId}.`);
          } else {
            putPayload.ListaVariacaoGrupo = [];
            console.log(`[SYNC-PRODUCTS] Sem variações válidas para o grupo ID ${codigoVariacaoGrupo}. Enviando ListaVariacaoGrupo como vazio.`);
          }

          try {
            console.log(`[SYNC-PRODUCTS] Efetuando chamada PUT para associar grupo de variação ao produto #${createdProductId}...`);
            const putRes = await axios.put(
              `${erpUrl}/produto/${createdProductId}`,
              putPayload,
              { headers, httpsAgent }
            );
            console.log(`[SYNC-PRODUCTS] Resposta do PUT para produto #${createdProductId}:`, JSON.stringify(putRes.data));
            console.log(`[SYNC-PRODUCTS] Vinculação realizada com sucesso via PUT.`);
          } catch (putErr: any) {
            console.error(`[SYNC-PRODUCTS] Falha ao enviar requisição PUT de vinculação de grupo`, putErr?.response?.data || putErr.message);
          }
        }
      }

      // Adicionando ao cardápio digital
      if (createdProductId) {
        await axios.put(
          `${erpUrl}/cardapio-digital/produto`,
          {
            "ListaCardapioDigitalProduto": [
              {
                "CodigoProduto": createdProductId,
                "Produto": { "CodigoProduto": createdProductId },
                "ProdutoPrecoTipo": { "CodigoProdutoPrecoTipo": 1 },
                "Valor": product.price,
                "Visivel": 1
              }
            ]
          },
          { headers, httpsAgent }
        );
      }

      results.push({ ...product, status: 'success', externalId: createdProductId });
    } catch (e: any) {
      console.error('Falhou no produto: ', product.name, e?.response?.data || e.message);
      let errorMsg = e?.response?.data || e.message;
      if (e?.response?.status === 401) {
         errorMsg = 'O Token de Sessão expirou ou é inválido (Erro 401). Por favor, renovar o Token nas Configurações de Sessão.';
      }
      results.push({ ...product, status: 'failed', error: errorMsg });
    }
    
    // Pequeno intervalo antes do próximo ciclo
    await new Promise(r => setTimeout(r, 1000));
  }

  res.json({ results });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
