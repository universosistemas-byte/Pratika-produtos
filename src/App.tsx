/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Upload, FileText, CheckCircle, AlertTriangle, Play, Save, Edit3, Trash2, Layers, Plus, X, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

function generateId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export type Variation = {
  name: string;
  price: number;
};

export type VariationGroup = {
  id: string;
  name: string;
  variations: Variation[];
  description?: string;
  targetProductsType?: string;
  codigoVariacaoGrupo?: string | number;
};

type Product = {
  id: string; // temporary for frontend keying
  name: string;
  price: number;
  barcode: string;
  groupId?: string;
  ncm?: string;
  variations?: Variation[];
  variationGroupName?: string;
  variationGroupId?: string;
  status?: 'pending' | 'success' | 'failed' | 'syncing';
  error?: string;
  externalId?: string;
  imageUrl?: string;
  candidateImages?: string[];
  isSearchingImage?: boolean;
};

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [sessionToken, setSessionToken] = useState<string>(() => {
    try {
      return localStorage.getItem('prd_session_token') || '';
    } catch (e) {
      return '';
    }
  });
  const [erpUrl, setErpUrl] = useState<string>(() => {
    try {
      return localStorage.getItem('prd_erp_url') || 'https://teste.pratikapdv.com';
    } catch (e) {
      return 'https://teste.pratikapdv.com';
    }
  });
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingEx, setLoadingEx] = useState(false);
  const [loadingSync, setLoadingSync] = useState(false);
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [tempToken, setTempToken] = useState('');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isTokenValid, setIsTokenValid] = useState<boolean | null>(null);
  const [tokenChecking, setTokenChecking] = useState(false);
  const [selectedProductForVariations, setSelectedProductForVariations] = useState<string | null>(null);
  const [selectedImageProduct, setSelectedImageProduct] = useState<Product | null>(null);
  const [editedImageUrl, setEditedImageUrl] = useState('');
  const [customSearchTerm, setCustomSearchTerm] = useState('');

  // Sync state values with active selected image editing product
  React.useEffect(() => {
    if (selectedImageProduct) {
      setEditedImageUrl(selectedImageProduct.imageUrl || '');
      setCustomSearchTerm(selectedImageProduct.name || '');
    }
  }, [selectedImageProduct]);

  // Image suggestion fetcher via server-side Gemini search helper
  const triggerImageSearch = async (product: Product, searchName?: string) => {
    const queryName = searchName || product.name;
    if (!queryName) return;

    setProducts(prev => prev.map(p => p.id === product.id ? { ...p, isSearchingImage: true } : p));
    if (selectedImageProduct && selectedImageProduct.id === product.id) {
      setSelectedImageProduct(prev => prev ? { ...prev, isSearchingImage: true } : null);
    }

    try {
      const res = await fetch('/api/search-product-images', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: queryName })
      });
      const data = await res.json();
      if (data && data.imageUrls) {
        const candidates = data.imageUrls;
        setProducts(prev => prev.map(p => {
          if (p.id === product.id) {
            return {
              ...p,
              candidateImages: candidates,
              imageUrl: p.imageUrl || candidates[0],
              isSearchingImage: false
            };
          }
          return p;
        }));

        if (selectedImageProduct && selectedImageProduct.id === product.id) {
          setSelectedImageProduct(prev => prev ? {
            ...prev,
            candidateImages: candidates,
            imageUrl: prev.imageUrl || candidates[0],
            isSearchingImage: false
          } : null);
        }
      } else {
        throw new Error(data.error || 'Erro inesperado ao buscar sugestões');
      }
    } catch (err: any) {
      console.error('Falha ao buscar imagens:', err);
      showToast(`Erro ao carregar imagens do produto "${queryName}": ${err.message}`, 'error');
      setProducts(prev => prev.map(p => p.id === product.id ? { ...p, isSearchingImage: false } : p));
      if (selectedImageProduct && selectedImageProduct.id === product.id) {
        setSelectedImageProduct(prev => prev ? { ...prev, isSearchingImage: false } : null);
      }
    }
  };

  // Non-blocking in-app notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' | 'info' } | null>(null);
  const showToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(prev => prev?.message === message ? null : prev);
    }, 4500);
  };

  // State-based dialog replaces for standard browser blocking calls
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [promptModal, setPromptModal] = useState<{ title: string; defaultValue: string; onConfirm: (val: string) => void; placeholder?: string } | null>(null);
  const [promptInputVal, setPromptInputVal] = useState('');
  
  // Reusable variation models state (templates)
  const [variationGroups, setVariationGroups] = useState<VariationGroup[]>([]);

  // Carrega modelos de variação baseados no Token de Sessão (Multi-tenant)
  React.useEffect(() => {
    try {
      const key = sessionToken ? `prd_variation_groups_${sessionToken}` : 'prd_variation_groups';
      const saved = localStorage.getItem(key);
      if (saved) {
        setVariationGroups(JSON.parse(saved));
      } else {
        setVariationGroups([
          {
            id: 'copo-tigela-preset',
            name: 'Modelo Copo e Tigela',
            description: 'Serve para determinar o tamanho do recipiente servido ao cliente.',
            targetProductsType: 'Caldo, Sorvete, Sopa, Tigela, Copo',
            variations: [
              { name: 'Copo', price: 13.00 },
              { name: 'Tigela', price: 26.00 }
            ]
          }
        ]);
      }
    } catch (e) {
      setVariationGroups([]);
    }
  }, [sessionToken]);

  const [editingGroup, setEditingGroup] = useState<VariationGroup | null>(null);
  const [applyingGroupToProducts, setApplyingGroupToProducts] = useState<VariationGroup | null>(null);
  const [selectedApplyProdIds, setSelectedApplyProdIds] = useState<string[]>([]);

  const updateSessionToken = (val: string) => {
    setSessionToken(val);
    try {
      localStorage.setItem('prd_session_token', val);
    } catch (e) {
      console.error('LocalStorage persistence error:', e);
    }
  };

  const updateErpUrl = (val: string) => {
    setErpUrl(val);
    try {
      localStorage.setItem('prd_erp_url', val);
    } catch (e) {
      console.error('LocalStorage persistence error for erpUrl:', e);
    }
  };

  const saveVariationGroups = (newGroups: VariationGroup[]) => {
    setVariationGroups(newGroups);
    try {
      const key = sessionToken ? `prd_variation_groups_${sessionToken}` : 'prd_variation_groups';
      localStorage.setItem(key, JSON.stringify(newGroups));
    } catch (e) {
      console.error('LocalStorage error saving variation groups:', e);
    }
  };

  const createOrUpdateGroup = (group: VariationGroup) => {
    const exists = variationGroups.some(g => g.id === group.id);
    let updated;
    if (exists) {
      updated = variationGroups.map(g => g.id === group.id ? group : g);
    } else {
      updated = [...variationGroups, group];
    }
    saveVariationGroups(updated);

    // Auto associar ao produto ativo se estivermos na modal de gerenciar variações do produto
    if (selectedProductForVariations) {
      setProducts(prev => prev.map(p => p.id === selectedProductForVariations ? { ...p, variationGroupName: group.name, variations: group.variations.map(v => ({ ...v })) } : p));
    }
    setEditingGroup(null);
  };

  const deleteGroup = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    setConfirmModal({
      message: 'Tem certeza de que deseja excluir este modelo de variação de forma permanente?',
      onConfirm: () => {
        const updated = variationGroups.filter(g => g.id !== id);
        saveVariationGroups(updated);
        showToast('Modelo de variação excluído com sucesso!', 'success');
      }
    });
  };

  const applyGroupToMultipleProducts = (groupId: string, productIds: string[]) => {
    const group = variationGroups.find(g => g.id === groupId);
    if (!group) return;

    setProducts(prevProducts => prevProducts.map(p => {
      if (productIds.includes(p.id)) {
        const clonedVariations = group.variations.map(v => ({ ...v }));
        return {
          ...p,
          variations: clonedVariations,
          variationGroupName: group.name
        };
      }
      return p;
    }));
    setApplyingGroupToProducts(null);
    setSelectedApplyProdIds([]);
  };

  const applyGroupToSingleProduct = (groupId: string, productId: string) => {
    const group = variationGroups.find(g => g.id === groupId);
    if (!group) return;

    setProducts(prevProducts => prevProducts.map(p => {
      if (p.id === productId) {
        const clonedVariations = group.variations.map(v => ({ ...v }));
        return {
          ...p,
          variations: clonedVariations,
          variationGroupName: group.name
        };
      }
      return p;
    }));
  };

  const findMatchingVariationGroup = (variations?: Variation[]) => {
    if (!variations || variations.length === 0) return null;
    for (const group of variationGroups) {
      if (group.variations.length === variations.length) {
        const match = group.variations.every(gVar => 
          variations.some(v => 
            (v.name || '').trim().toLowerCase() === (gVar.name || '').trim().toLowerCase() && 
            Number(v.price) === Number(gVar.price)
          )
        );
        if (match) return group;
      }
    }
    return null;
  };

  const handleVariationChange = (prodId: string, varIdx: number, field: keyof Variation, value: string | number) => {
    setProducts(prevProducts => prevProducts.map(p => {
      if (p.id === prodId) {
        const updatedVariations = [...(p.variations || [])];
        if (updatedVariations[varIdx]) {
          updatedVariations[varIdx] = {
            ...updatedVariations[varIdx],
            [field]: value
          };
        }
        // Auto match to a template model if applicable or clear if mismatching
        const matched = findMatchingVariationGroup(updatedVariations);
        return { 
          ...p, 
          variations: updatedVariations,
          variationGroupName: matched ? matched.name : undefined
        };
      }
      return p;
    }));
  };

  const addVariation = (prodId: string) => {
    setProducts(prevProducts => prevProducts.map(p => {
      if (p.id === prodId) {
        const updatedVariations = [...(p.variations || [])];
        updatedVariations.push({ name: '', price: p.price || 0 });
        return { ...p, variations: updatedVariations };
      }
      return p;
    }));
  };

  const removeVariation = (prodId: string, varIdx: number) => {
    setProducts(prevProducts => prevProducts.map(p => {
      if (p.id === prodId) {
        const updatedVariations = [...(p.variations || [])];
        updatedVariations.splice(varIdx, 1);
        return { ...p, variations: updatedVariations };
      }
      return p;
    }));
  };

  const activeVariationsProduct = products.find(p => p.id === selectedProductForVariations);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      const selected = Array.from(e.target.files);
      setFiles(prev => [...prev, ...selected]);
    }
  };

  const removeUploadedFile = (idx: number) => {
    setFiles(prev => prev.filter((_, i) => i !== idx));
  };

  const extractMenu = async (providedToken?: string | React.MouseEvent) => {
    if (files.length === 0) return;
    
    const activeToken = typeof providedToken === 'string' ? providedToken : sessionToken;

    if (!activeToken) {
      setShowTokenModal(true);
      return;
    }

    setLoadingEx(true);
    setProducts([]);
    const formData = new FormData();
    files.forEach(f => {
      formData.append('images', f);
    });
    formData.append('sessionToken', activeToken);
    formData.append('erpUrl', erpUrl);

    try {
      setErrorMessage(null);
      const res = await fetch('/api/extract-menu', {
        method: 'POST',
        body: formData,
      });
      
      const rawText = await res.text();
      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        if (rawText.includes('AI Studio Logo') || rawText.includes('cookie check')) {
          throw new Error('Autenticação necessária. Por favor, abra este aplicativo em uma nova aba (ícone no canto superior direito) para liberar o acesso.');
        }
        throw new Error(`Falha no servidor. (Status ${res.status}): ${rawText}`);
      }
      
      if (!res.ok) {
        throw new Error(data.error || data.details || 'Erro desconhecido da API');
      }

      if (data.products) {
        const updatedVariationGroups = [...variationGroups];
        
        const withIds = data.products.map((p: any) => {
          const productWithId = {
            ...p,
            id: generateId(),
            status: 'pending'
          };
          
          if (productWithId.variations && productWithId.variations.length > 0) {
            let matched = null;
            for (const g of updatedVariationGroups) {
              if (g.variations.length === productWithId.variations.length) {
                const isMatch = g.variations.every(gVar => 
                  productWithId.variations.some((v: any) => 
                    (v.name || '').trim().toLowerCase() === (gVar.name || '').trim().toLowerCase() && 
                    Number(v.price) === Number(gVar.price)
                  )
                );
                if (isMatch) {
                  matched = g;
                  break;
                }
              }
            }
            
            if (matched) {
              productWithId.variationGroupName = matched.name;
              productWithId.variationGroupId = matched.codigoVariacaoGrupo ? String(matched.codigoVariacaoGrupo) : undefined;
            } else {
              let newGroupName = (productWithId.variationGroupName || `Opções ${productWithId.name}`).trim();
              
              const newGroup: VariationGroup = {
                id: generateId(),
                name: newGroupName,
                description: `Grupo criado a partir de ${productWithId.name}.`,
                variations: productWithId.variations.map((v: any) => ({ ...v }))
              };
              
              updatedVariationGroups.push(newGroup);
              productWithId.variationGroupName = newGroup.name;
            }
          }
          
          return productWithId;
        });
        
        if (updatedVariationGroups.length !== variationGroups.length) {
          saveVariationGroups(updatedVariationGroups);
        }
        
        setProducts(withIds);

        // Dispara de forma assíncrona com espaçamento amigável (proteção antibot do Google Imagens)
        withIds.forEach((p: any, i: number) => {
          setTimeout(() => {
            triggerImageSearch(p);
          }, 500 + (i * 1200));
        });
      } else {
        throw new Error(data.error || 'Erro ao extrair');
      }
    } catch (err: any) {
      console.error(err);
      setErrorMessage(err.message);
      showToast(`Erro de comunicação: ${err.message}`, 'error');
    } finally {
      setLoadingEx(false);
    }
  };

  const handleProductChange = (index: number, field: keyof Product, value: string | number) => {
    const newProds = [...products];
    newProds[index] = { ...newProds[index], [field]: value };
    setProducts(newProds);
  };

  const loadGroupsFromExt = async (tokenToCheck?: string) => {
    const token = tokenToCheck || sessionToken;
    if (!token) {
      setIsTokenValid(null);
      return;
    }
    setTokenChecking(true);
    try {
      const res = await fetch('/api/list-groups', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: token, erpUrl })
      });
      
      if (res.status === 401) {
        setIsTokenValid(false);
        return;
      }
      
      const data = await res.json();
      if (res.ok && data && (data.groups || Array.isArray(data))) {
        setIsTokenValid(true);
        console.log("Groups loaded remotely", data.groups);
      } else {
        setIsTokenValid(false);
      }
    } catch(err) {
       console.log('Groups could not be loaded on frontend', err);
       setIsTokenValid(null);
    } finally {
       setTokenChecking(false);
    }
  };

  React.useEffect(() => {
    if (sessionToken) {
      loadGroupsFromExt();
    } else {
      setIsTokenValid(null);
    }
  }, [sessionToken, erpUrl]);

  const removeProduct = (index: number) => {
    const newProds = [...products];
    newProds.splice(index, 1);
    setProducts(newProds);
  };

  const syncProducts = async () => {
    if (!sessionToken) {
      showToast('Por favor, informe o Token / Cookie de Sessão.', 'error');
      return;
    }
    
    const pendingProducts = products.filter(p => !p.status || p.status === 'pending' || p.status === 'failed');
    if (pendingProducts.length === 0) {
      showToast('Nenhum produto pendente para sincronizar.', 'info');
      return;
    }

    setLoadingSync(true);
    setErrorMessage(null);

    // Cache local de grupos de variação sincronizados na sessão atual para evitar requisições duplicadas
    const sessionGroupCache: Record<string, string | number> = {};
    
    // Process products sequentially
    for (let i = 0; i < pendingProducts.length; i++) {
      const originalProd = pendingProducts[i];
      
      // Enrich variation group name if identical to an existing model
      let currentProd = { ...originalProd };
      if (currentProd.variations && currentProd.variations.length > 0 && !currentProd.variationGroupName) {
        const matched = findMatchingVariationGroup(currentProd.variations);
        if (matched) {
          currentProd.variationGroupName = matched.name;
        }
      }

      // Se o produto possui variações, garante que o grupo de variação seja cadastrado primeiro no ERP
      if (currentProd.variations && currentProd.variations.length > 0) {
        let nomeGrupoVariavel = (currentProd.variationGroupName || `OPC - ${currentProd.name.substring(0, 20)}`).trim();
        const cacheKey = nomeGrupoVariavel.toUpperCase();

        let targetId = sessionGroupCache[cacheKey];

        // 1. Tenta recuperar do modelo de variação correspondente que já possui ID ERP cadastrado
        if (!targetId) {
          const matched = findMatchingVariationGroup(currentProd.variations);
          if (matched && matched.codigoVariacaoGrupo) {
            targetId = matched.codigoVariacaoGrupo;
            sessionGroupCache[cacheKey] = targetId;
            console.log(`[FRONTEND-REUSO] Reusando ID ERP já associado ao modelo: "${nomeGrupoVariavel}" -> ID ${targetId}`);
          }
        }

        // 2. Se não está em cache nem no modelo, faz o cadastro no ERP preventivamente antes de mandar o produto
        if (!targetId) {
          // Exibe o feedback visual na tabela que está cadastrando o grupo de variação do produto
          setProducts(prevProducts => prevProducts.map(p => 
            p.id === currentProd.id ? { ...p, status: 'syncing', error: 'Cadastrando grupo de opções...' } : p
          ));

          try {
            console.log(`[FRONTEND-CADASTRO] Sincronizando grupo de variações no ERP para o produto "${currentProd.name}": "${nomeGrupoVariavel}"`);
            const vgRes = await fetch('/api/sync-variation-group', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ 
                sessionToken, 
                variationGroupName: nomeGrupoVariavel, 
                variations: currentProd.variations,
                erpUrl
              })
            });

            const vgRaw = await vgRes.text();
            let vgData;
            try {
              vgData = JSON.parse(vgRaw);
            } catch (e) {
              throw new Error(`Resposta inválida do servidor ao registrar variações: ${vgRaw.substring(0, 100)}`);
            }

            if (!vgRes.ok) {
              throw new Error(vgData.error || vgData.details || 'Falha na resposta ao sincronizar variações');
            }

            if (vgData && vgData.codigoVariacaoGrupo) {
              targetId = vgData.codigoVariacaoGrupo;
              sessionGroupCache[cacheKey] = targetId;
              console.log(`[FRONTEND-SUCESSO] Grupo de variação cadastrado / recuperado com sucesso: "${nomeGrupoVariavel}" -> ID ${targetId}`);
              
              // Atualiza o modelo de variações correspondente na lista lateral para persistir a associação
              const matched = findMatchingVariationGroup(currentProd.variations);
              if (matched) {
                setVariationGroups(prevGroups => {
                  const updated = prevGroups.map(g => g.id === matched.id ? { ...g, codigoVariacaoGrupo: targetId } : g);
                  try {
                    const key = sessionToken ? `prd_variation_groups_${sessionToken}` : 'prd_variation_groups';
                    localStorage.setItem(key, JSON.stringify(updated));
                  } catch (e) {
                    console.error('Falha ao salvar modelos atualizados no LocalStorage:', e);
                  }
                  return updated;
                });
              }
            } else {
              throw new Error('Não foi retornado um ID válido para o grupo de variação cadastrado.');
            }
          } catch (err: any) {
            console.error('Falha ao cadastrar grupo de variações:', err);
            setProducts(prevProducts => prevProducts.map(p => 
              p.id === currentProd.id ? { ...p, status: 'failed', error: `Falha nas variações: ${err.message}` } : p
            ));
            setErrorMessage(`Falha ao registrar grupo de variações para "${currentProd.name}": ${err.message}`);
            // Pula para o próximo item do loop
            continue;
          }
        }

        // 3. Associa o ID correto no payload do produto a ser sincronizado
        if (targetId) {
          currentProd.variationGroupId = String(targetId);
        }
      }

      // Update state to show that this specific item is syncing
      setProducts(prevProducts => prevProducts.map(p => 
        p.id === currentProd.id ? { ...p, status: 'syncing', error: undefined } : p
      ));

      try {
        const res = await fetch('/api/sync-products', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken, products: [currentProd], erpUrl })
        });
        
        const rawText = await res.text();
        let data;
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          if (rawText.includes('AI Studio Logo') || rawText.includes('cookie check')) {
            throw new Error('Autenticação necessária. Por favor, abra esse aplicativo em uma nova aba (botão acima) para liberar o acesso.');
          }
          throw new Error(`Falha no servidor. (Status ${res.status}): ${rawText}`);
        }

        if (data && data.results && data.results.length > 0) {
          const match = data.results[0];
          setProducts(prevProducts => prevProducts.map(p => 
            p.id === currentProd.id ? {
              ...p,
              status: match.status,
              error: match.error,
              externalId: match.externalId,
              // Mantém o ID das variações associado no estado do produto
              variationGroupId: currentProd.variationGroupId
            } : p
          ));
        } else {
          setProducts(prevProducts => prevProducts.map(p => 
            p.id === currentProd.id ? { ...p, status: 'failed', error: 'Nenhum resultado retornado do servidor.' } : p
          ));
        }
      } catch (err: any) {
        console.error('Error syncing single product:', err);
        setProducts(prevProducts => prevProducts.map(p => 
          p.id === currentProd.id ? { ...p, status: 'failed', error: err.message } : p
        ));
        setErrorMessage(`Falha ao enviar "${currentProd.name}": ${err.message}`);
      }
    }
    
    setLoadingSync(false);
  };

  return (
    <div className="flex flex-col h-screen w-full bg-[#F1F5F9] font-sans text-slate-800 overflow-hidden">
      {/* Iframe Cookie Warning Banner */}
      {typeof window !== 'undefined' && window.self !== window.top && (
        <div className="bg-amber-500 text-white font-semibold text-xs py-2 px-6 flex items-center justify-between gap-3 shrink-0 shadow-sm border-b border-amber-600">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-100 shrink-0" />
            <span>Atenção: Você está visualizando o app dentro de um iframe. Se encontrar erros de autenticação, clique em "Abrir em Nova Aba" ao lado.</span>
          </div>
          <button 
            type="button"
            onClick={() => window.open(window.location.href, '_blank')}
            className="bg-white/20 hover:bg-white/30 text-white font-bold px-3 py-1 rounded text-[10px] transition-colors cursor-pointer shrink-0"
          >
            Abrir em Nova Aba
          </button>
        </div>
      )}
      {/* Top Navigation */}
      <nav className="h-16 px-8 bg-white border-b border-slate-200 flex items-center justify-between custom-shadow shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-600 rounded-lg flex items-center justify-center text-white font-bold text-xl">
            <FileText size={20} />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight text-slate-900">Cadastro Mágiko <span className="text-blue-600">PRD</span></h1>
            <p className="text-xs text-slate-500">Extração e sincronização em massa</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <button
            onClick={() => window.open(window.location.href, '_blank')}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3.5 py-1.5 rounded-full border transition-all cursor-pointer ${
              typeof window !== 'undefined' && window.self !== window.top
                ? 'bg-blue-600 text-white border-blue-600 hover:bg-blue-700 shadow-md shadow-blue-100 animate-pulse' 
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
            }`}
            title="Abrir em uma nova aba para evitar restrições de cookies em iframes do navegador"
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
            Abrir em Nova Aba
          </button>

          {sessionToken && (
            <div className="flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-700 border border-green-200 rounded-full text-xs font-medium">
              <span className="w-2 h-2 bg-green-500 rounded-full status-pulse"></span>
              Sessão Ativa
            </div>
          )}
          <div className="w-8 h-8 rounded-full bg-slate-200 border border-slate-300"></div>
        </div>
      </nav>

      {/* Main Content Layout */}
      <main className="flex flex-1 overflow-hidden p-6 gap-6">
        
        {/* Sidebar Controls */}
        <div className="flex flex-col gap-6 shrink-0 w-80 overflow-y-auto pb-4">
          {/* Phase Indicator */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 custom-shadow">
            <h2 className="text-sm font-semibold mb-4 uppercase tracking-wider text-slate-500 italic">PRD Workflow</h2>
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full border-2 ${files.length > 0 ? 'step-active' : 'step-inactive'} flex items-center justify-center text-xs font-bold`}>1</div>
                <span className={`text-sm ${files.length > 0 ? 'font-bold text-blue-600' : 'font-medium'}`}>Upload do Cardápio</span>
              </div>
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full border-2 ${loadingEx || products.length > 0 ? 'step-active' : 'step-inactive'} flex items-center justify-center text-xs font-bold`}>2</div>
                <span className={`text-sm ${loadingEx || products.length > 0 ? 'font-bold text-blue-600' : 'font-medium'}`}>Extração com IA</span>
              </div>
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full border-2 ${products.length > 0 ? 'step-active' : 'step-inactive'} flex items-center justify-center text-xs font-bold`}>3</div>
                <span className={`text-sm ${products.length > 0 ? 'font-bold text-blue-600' : 'font-medium'}`}>Conferência de Dados</span>
              </div>
              <div className="flex items-center gap-3">
                <div className={`w-6 h-6 rounded-full border-2 ${loadingSync ? 'step-active' : 'step-inactive'} flex items-center justify-center text-xs font-bold opacity-40`}>4</div>
                <span className="text-sm font-medium">Sincronização em Massa</span>
              </div>
            </div>
          </div>

          {/* Upload Dropzone */}
          <label className="bg-white border-2 border-dashed border-slate-300 rounded-2xl flex flex-col items-center justify-center p-6 text-center group cursor-pointer hover:border-blue-400 hover:bg-blue-50 transition-colors">
            <div className="w-12 h-12 bg-slate-100 rounded-full flex items-center justify-center mb-3 group-hover:bg-blue-100 transition-colors">
              <Upload className="w-6 h-6 text-slate-500 group-hover:text-blue-600" />
            </div>
            <p className="text-sm font-semibold text-slate-700">Selecione imagens de cardápio</p>
            <p className="text-xs text-slate-400 mt-1">Selecione uma ou mais imagens (JPG, PNG)</p>
            <input type="file" className="hidden" accept="image/*" multiple onChange={handleFileChange} />
          </label>

          {/* List of uploaded files */}
          {files.length > 0 && (
            <div className="bg-slate-50 border border-slate-200 rounded-2xl p-3 flex flex-col gap-2 max-h-[180px] overflow-y-auto">
              <div className="flex items-center justify-between text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">
                <span>Imagens ({files.length})</span>
                <button 
                  type="button" 
                  onClick={() => setFiles([])} 
                  className="text-red-500 hover:text-red-700 text-[10px] font-semibold cursor-pointer"
                >
                  Limpar todas
                </button>
              </div>
              <ul className="space-y-1.5">
                {files.map((f, idx) => (
                  <li key={idx} className="flex items-center justify-between bg-white px-2.5 py-1.5 rounded-lg border border-slate-100 text-xs text-slate-700 italic group/item">
                    <span className="truncate max-w-[180px]" title={f.name}>{f.name}</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        removeUploadedFile(idx);
                      }}
                      className="p-1 rounded text-slate-400 hover:text-red-500 hover:bg-slate-50 transition-all cursor-pointer flex items-center justify-center shrink-0"
                    >
                      <X size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <button
            className="w-full flex items-center justify-center gap-2 bg-slate-900 text-white rounded-xl py-3 px-4 font-semibold hover:bg-slate-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed custom-shadow"
            onClick={extractMenu}
            disabled={files.length === 0 || loadingEx}
          >
            {loadingEx ? 'Processando IA...' : `Extrair (${files.length}) com IA`}
          </button>

          {/* Modelos de Variação (Reusable Groups) */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 custom-shadow flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-bold text-slate-900 flex items-center gap-1.5">
                  <Layers size={16} className="text-blue-600" />
                  Modelos de Variação
                </h2>
                <p className="text-[10px] text-slate-500 font-medium">Crie grupos e aplique em vários produtos</p>
              </div>
              <button
                type="button"
                onClick={() => setEditingGroup({ id: generateId(), name: '', variations: [{ name: '', price: 0 }] })}
                className="p-1 rounded-lg hover:bg-blue-50 text-blue-600 bg-blue-50/50 border border-blue-100 transition-colors flex items-center justify-center cursor-pointer"
                title="Criar novo modelo"
              >
                <Plus size={14} />
              </button>
            </div>

            <div className="space-y-2.5 max-h-[220px] overflow-y-auto pr-1">
              {variationGroups.length === 0 ? (
                <div className="text-center py-6 text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-3">
                  <p className="text-xs font-semibold text-slate-500">Nenhum modelo salvo</p>
                  <p className="text-[10px] text-slate-400 mt-0.5 leading-tight">Crie modelos (ex: Copo e Tigela) para aplicar em massa.</p>
                </div>
              ) : (
                variationGroups.map((g) => (
                  <div key={g.id} className="relative group/card bg-slate-50 hover:bg-slate-50/80 border border-slate-100 rounded-xl p-3 flex flex-col gap-1.5 transition-all">
                    <div className="flex items-center justify-between gap-1.5">
                      <span className="text-xs font-bold text-slate-800 truncate">{g.name}</span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => {
                            setApplyingGroupToProducts(g);
                            setSelectedApplyProdIds([]);
                          }}
                          className="p-1 rounded hover:bg-blue-100 text-blue-600 transition-colors cursor-pointer"
                          title="Associar a múltiplos produtos"
                        >
                          <Layers size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditingGroup({ ...g })}
                          className="p-1 rounded hover:bg-slate-200 text-slate-500 transition-colors cursor-pointer"
                          title="Editar modelo"
                        >
                          <Edit3 size={12} />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => deleteGroup(g.id, e)}
                          className="p-1 rounded hover:bg-rose-100 text-rose-500 transition-colors cursor-pointer"
                          title="Excluir"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>

                    {g.description && (
                      <div className="text-[10px] text-slate-500 font-medium italic border-l-2 border-slate-200 pl-2 leading-tight py-0.5">
                        "{g.description}"
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-1.5">
                      {g.targetProductsType && (
                        <span className="bg-slate-100 text-slate-600 rounded px-1.5 py-0.5 text-[8px] font-semibold">
                          Para: {g.targetProductsType}
                        </span>
                      )}
                      {g.codigoVariacaoGrupo && (
                        <span className="bg-green-50 text-green-700 border border-green-200 rounded px-1.5 py-0.5 text-[8px] font-bold shadow-xs">
                          Sincronizado (ID: {g.codigoVariacaoGrupo})
                        </span>
                      )}
                    </div>

                    {/* Variations Preview */}
                    <div className="flex flex-wrap gap-1">
                      {g.variations.map((v, idx) => (
                        <span key={idx} className="bg-white border border-slate-200/60 rounded-full px-2 py-0.5 text-[9px] font-semibold text-slate-600 flex items-center gap-1 shadow-sm">
                          {v.name || 'Sem nome'}: <span className="text-blue-600 font-bold">R$ {v.price}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Configuração */}
          <div className="bg-white p-5 rounded-2xl border border-slate-200 custom-shadow mt-auto">
            <h2 className="text-sm font-semibold mb-4 text-slate-700 uppercase tracking-wider">Autorização</h2>
            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Ambiente Integrado</label>
                <select 
                  className="w-full text-sm border border-slate-200 bg-slate-50 rounded-lg px-3 py-2 outline-none transition-all focus:bg-white focus:ring-2 focus:ring-blue-500"
                  value={erpUrl}
                  onChange={e => updateErpUrl(e.target.value)}
                >
                  <option value="https://teste.pratikapdv.com">⚙️ Testes (teste.pratikapdv.com)</option>
                  <option value="https://pratika.appspot.com">🚀 Produção (pratika.appspot.com)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1">Cookie SESSION do PDV</label>
                <input 
                  type="text" 
                  placeholder="28765095ce..." 
                  className={`w-full text-sm border rounded-lg px-3 py-2 outline-none transition-all ${
                     isTokenValid === true ? 'border-emerald-300 bg-emerald-50/20 focus:ring-emerald-500' :
                     isTokenValid === false ? 'border-rose-300 bg-rose-50/20 focus:ring-rose-500 focus:ring-2' :
                     'border-slate-200 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500'
                  }`}
                  value={sessionToken}
                  onChange={e => updateSessionToken(e.target.value)}
                />
                
                {sessionToken && (
                  <div className="mt-2 text-[11px] font-semibold flex items-center gap-1 leading-normal">
                    {tokenChecking ? (
                      <span className="text-slate-500 flex items-center gap-1">
                        <span className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-ping"></span>
                        Verificando conexão...
                      </span>
                    ) : isTokenValid === true ? (
                      <span className="text-emerald-700 flex items-center gap-1 bg-emerald-100/45 px-2 py-0.5 rounded-md border border-emerald-200/50">
                        ● Token de Sessão Ativo e Válido
                      </span>
                    ) : isTokenValid === false ? (
                      <span className="text-rose-700 flex items-center gap-1 bg-rose-100/40 px-2 py-0.5 rounded-md border border-rose-200/40 animate-pulse">
                        ⚠️ Cookie de Sessão expirado ou inválido!
                      </span>
                    ) : null}
                  </div>
                )}
                <p className="text-[10px] text-slate-400 mt-1 lines-tight">Insira aqui para a IA já puxar os Grupos corretos na extração e realizar a Sincronização em Massa.</p>
              </div>
              <button
                className="w-full flex items-center justify-center gap-2 bg-blue-600 text-white rounded-lg py-2.5 px-4 font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-200"
                onClick={syncProducts}
                disabled={products.length === 0 || loadingSync || !sessionToken}
              >
                {loadingSync ? 'Enviando...' : 'Aprovar Envio em Massa'}
              </button>
            </div>
          </div>
        </div>

        {/* Right Dashboard Area */}
        <div className="flex-1 flex flex-col gap-6 min-w-0">
          
          {errorMessage && (
            <div className="p-4 bg-orange-50 border border-orange-200 text-orange-800 rounded-2xl flex items-start gap-4 shadow-sm border-l-4 border-l-orange-500 relative shrink-0">
              <div className="p-1 px-1.5 bg-orange-100 rounded-lg text-orange-600 mt-0.5 shrink-0">
                <AlertTriangle size={18} />
              </div>
              <div className="flex-1 min-w-0">
                <h4 className="font-bold text-sm text-orange-950">Aviso do Sistema</h4>
                <p className="text-xs text-orange-800 mt-1 leading-relaxed font-semibold">{errorMessage}</p>
                {errorMessage.includes('nova aba') && (
                  <button
                    onClick={() => {
                      setErrorMessage(null);
                      window.open(window.location.href, '_blank');
                    }}
                    className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 px-4 py-2 rounded-lg transition-colors cursor-pointer shadow-sm shadow-blue-100"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                    </svg>
                    Abrir em Nova Aba Agora
                  </button>
                )}
              </div>
              <button 
                onClick={() => setErrorMessage(null)}
                className="absolute top-3 right-3 p-1 rounded-lg text-orange-400 hover:text-orange-600 hover:bg-orange-100 transition-colors"
                title="Fechar"
              >
                <X size={16} />
              </button>
            </div>
          )}

          {/* Stats / Summary Row */}
          <div className="grid grid-cols-3 gap-4 shrink-0">
            <div className="bg-white p-4 rounded-xl border border-slate-200 custom-shadow flex flex-col">
              <span className="text-xs text-slate-500 uppercase font-bold tracking-tight">Itens Detectados</span>
              <span className="text-2xl font-bold">{products.length}</span>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 custom-shadow flex flex-col">
              <span className="text-xs text-slate-500 uppercase font-bold tracking-tight">Pendentes</span>
              <span className="text-2xl font-bold text-blue-600">{products.filter(p => !p.status || p.status === 'pending').length}</span>
            </div>
            <div className="bg-white p-4 rounded-xl border border-slate-200 custom-shadow flex flex-col">
              <span className="text-xs text-slate-500 uppercase font-bold tracking-tight">Erros / Revisar</span>
              <span className="text-2xl font-bold text-orange-500">{products.filter(p => p.status === 'failed').length}</span>
            </div>
          </div>

          {/* Main Data Grid */}
          <div className="flex-1 bg-white rounded-2xl border border-slate-200 custom-shadow flex flex-col overflow-hidden">
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between bg-slate-50/50">
              <h3 className="font-bold text-slate-800">Fila de Conferência</h3>
            </div>
            
            <div className="flex-1 overflow-auto">
              {products.length === 0 && !loadingEx ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-400 p-12">
                  <Edit3 size={48} className="mb-4 opacity-20" />
                  <p className="font-semibold text-slate-500">Aguardando Extração</p>
                  <p className="text-sm mt-1 text-slate-400">Faça o upload do cardápio para processar os itens.</p>
                </div>
              ) : (
                <table className="w-full text-left">
                  <thead className="text-[11px] uppercase tracking-wider text-slate-500 font-bold bg-slate-50 sticky top-0 shadow-sm z-10 whitespace-nowrap">
                    <tr>
                      <th className="px-4 py-3 border-b border-slate-200 text-center w-16">Foto</th>
                      <th className="px-6 py-3 border-b border-slate-200">Cod. Barras / EAN</th>
                      <th className="px-6 py-3 border-b border-slate-200">Nome do Item</th>
                      <th className="px-6 py-3 border-b border-slate-200">ID do Grupo</th>
                      <th className="px-6 py-3 border-b border-slate-200">NCM</th>
                      <th className="px-6 py-3 border-b border-slate-200 text-right">Preço</th>
                      <th className="px-6 py-3 border-b border-slate-200 text-center">Status</th>
                      <th className="px-6 py-3 border-b border-slate-200 text-center">Ações</th>
                    </tr>
                  </thead>
                  <tbody className="text-sm divide-y divide-slate-50">
                    {products.map((prod, idx) => (
                      <motion.tr 
                        initial={{ opacity: 0, y: 5 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: idx * 0.05 }}
                        key={prod.id} 
                        className={`hover:bg-slate-50 transition-colors ${prod.status === 'failed' ? 'bg-orange-50/30' : ''}`}
                      >
                        <td className="px-4 py-2 text-center w-16 shrink-0">
                          {prod.imageUrl ? (
                            <div 
                              className="relative group w-10 h-10 mx-auto rounded-lg overflow-hidden border border-slate-200 shadow-xs cursor-pointer bg-slate-100 flex items-center justify-center" 
                              onClick={() => setSelectedImageProduct(prod)}
                            >
                              <img 
                                src={prod.imageUrl} 
                                alt={prod.name} 
                                className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-200" 
                                referrerPolicy="no-referrer" 
                                onError={(e) => {
                                  e.currentTarget.src = "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=100&auto=format&fit=crop&q=60";
                                }}
                              />
                              <div className="absolute inset-0 bg-black/45 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity text-white text-[9px] font-bold">
                                Mudar
                              </div>
                            </div>
                          ) : (
                            <button 
                              type="button"
                              onClick={() => setSelectedImageProduct(prod)}
                              className="w-10 h-10 mx-auto rounded-lg bg-slate-50 hover:bg-blue-50 text-slate-400 hover:text-blue-600 border border-slate-200 flex flex-col items-center justify-center cursor-pointer transition-colors"
                              title="Configurar Foto"
                            >
                              {prod.isSearchingImage ? (
                                <Loader2 size={12} className="animate-spin text-blue-600" />
                              ) : (
                                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                                </svg>
                              )}
                            </button>
                          )}
                        </td>
                        <td className="px-6 py-2 font-mono text-xs w-48">
                          <input 
                            type="text" 
                            value={prod.barcode}
                            onChange={(e) => handleProductChange(idx, 'barcode', e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-1 transition-colors outline-none"
                          />
                        </td>
                        <td className="px-6 py-2 font-medium">
                          <input 
                            type="text" 
                            value={prod.name}
                            onChange={(e) => handleProductChange(idx, 'name', e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-1 transition-colors outline-none text-slate-900 font-semibold"
                          />
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            {prod.variations && prod.variations.length > 0 ? (
                              <button
                                type="button" 
                                onClick={() => setSelectedProductForVariations(prod.id)}
                                className="text-[10px] font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 hover:border-blue-300 px-2 py-0.5 rounded-full flex items-center gap-1 cursor-pointer transition-colors animate-pulse"
                              >
                                <Layers size={10} />
                                {prod.variations.length} {prod.variations.length === 1 ? 'Variação' : 'Variações'} (Visualizar)
                              </button>
                            ) : (
                              <button
                                type="button" 
                                onClick={() => setSelectedProductForVariations(prod.id)}
                                className="text-[10px] font-medium text-slate-500 hover:text-blue-600 hover:bg-blue-50 border border-slate-200 hover:border-blue-100 px-2 py-0.5 rounded-full flex items-center gap-1 cursor-pointer transition-colors"
                              >
                                <Plus size={10} />
                                Adicionar Variações
                              </button>
                            )}

                            {prod.variationGroupName && (
                              <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-150 px-2.5 py-0.5 rounded-full flex items-center gap-1 shadow-sm" title="Reutilizando este grupo de variação">
                                <Layers size={9} />
                                Modelo: {prod.variationGroupName}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-6 py-2 font-medium w-32">
                          <input 
                            type="text" 
                            value={prod.groupId || ''}
                            placeholder="Cod. Grupo"
                            onChange={(e) => handleProductChange(idx, 'groupId', e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-1 transition-colors outline-none"
                          />
                        </td>
                        <td className="px-6 py-2 font-medium w-32">
                          <input 
                            type="text" 
                            value={prod.ncm || ''}
                            placeholder="NCM"
                            onChange={(e) => handleProductChange(idx, 'ncm', e.target.value)}
                            className="w-full bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-1 transition-colors outline-none font-mono text-xs"
                          />
                        </td>
                        <td className="px-6 py-2 text-right text-blue-600 font-bold w-32">
                          <input 
                            type="number" 
                            step="0.01"
                            value={prod.price}
                            onChange={(e) => handleProductChange(idx, 'price', parseFloat(e.target.value))}
                            className="w-full text-right bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-1 transition-colors outline-none font-bold text-blue-600"
                          />
                        </td>
                        <td className="px-6 py-2 text-center w-24">
                          {prod.status === 'success' && <div className="w-7 h-7 mx-auto rounded bg-green-50 text-green-600 flex items-center justify-center" title="Sincronizado com sucesso!"><CheckCircle size={16} className="font-bold"/></div>}
                          {prod.status === 'failed' && <div title={prod.error || 'Erro desconhecido'} className="w-7 h-7 mx-auto rounded bg-orange-50 text-orange-600 flex items-center justify-center cursor-help"><AlertTriangle size={16} className="font-bold"/></div>}
                          {prod.status === 'syncing' && <div className="w-7 h-7 mx-auto flex items-center justify-center text-blue-600" title="Enviando para o ERP..."><Loader2 size={16} className="animate-spin" /></div>}
                          {(!prod.status || prod.status === 'pending') && <span className="w-2 h-2 rounded-full bg-amber-400 inline-block" title="Pendente"></span>}
                        </td>
                        <td className="px-6 py-2 text-center w-20">
                          <button 
                            title="Remover Item"
                            onClick={() => removeProduct(idx)}
                            className="w-7 h-7 mx-auto rounded bg-rose-50 text-rose-500 hover:bg-rose-100 hover:text-rose-600 flex items-center justify-center transition-colors shadow-sm"
                          >
                            <Trash2 size={16} />
                          </button>
                        </td>
                      </motion.tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      </main>

      {/* Bottom Progress Status */}
      <footer className="h-10 px-6 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-4">
          <span className="text-[10px] font-bold text-slate-400 uppercase tracking-widest">Sessão {sessionToken ? 'Ativa' : 'Pendente'}</span>
          <div className="h-1.5 w-48 bg-slate-200 rounded-full overflow-hidden">
            <div 
              className="h-full bg-blue-600 transition-all duration-500" 
              style={{ width: `${products.length > 0 ? (products.filter(p => p.status === 'success').length / products.length) * 100 : 0}%` }}
            ></div>
          </div>
          <span className="text-[10px] font-medium text-slate-600">
            {products.length > 0 ? `${Math.round((products.filter(p => p.status === 'success').length / products.length) * 100)}% Concluído` : '0%'}
          </span>
        </div>
        <p className="text-[10px] text-slate-400 italic font-medium tracking-tight">PratikaBot PRD — v1.0.0</p>
      </footer>

      {/* Modal - Solicitar Token */}
      {showTokenModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white p-6 rounded-2xl shadow-xl w-full max-w-sm border border-slate-200"
          >
            <h2 className="text-lg font-bold mb-2 text-slate-800">Token Necessário</h2>
            <p className="text-sm text-slate-500 mb-5 leading-relaxed">
              Precisamos do Cookie SESSION ativo para descobrir seus grupos de produtos. Cole seu token abaixo para continuar.
            </p>
            <input 
              type="text" 
              value={tempToken} 
              onChange={e => setTempToken(e.target.value)} 
              placeholder="ex: 28765095ce..."
              className="w-full text-sm border border-slate-300 rounded-lg px-3 py-2.5 mb-6 bg-slate-50 focus:bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all font-mono"
            />
            <div className="flex gap-3">
              <button 
                onClick={() => setShowTokenModal(false)} 
                className="flex-1 px-4 py-2 text-sm font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors"
              >
                Cancelar
              </button>
              <button 
                onClick={() => {
                  if (tempToken.trim()) {
                    updateSessionToken(tempToken.trim());
                    setShowTokenModal(false);
                    extractMenu(tempToken.trim());
                  }
                }} 
                disabled={!tempToken.trim()}
                className="flex-1 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-lg transition-colors"
              >
                Continuar
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Modal - Gerenciar Variações */}
      {selectedProductForVariations && activeVariationsProduct && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-xl w-full max-w-xl border border-slate-200 flex flex-col max-h-[85vh]"
          >
            <div className="flex items-center justify-between p-5 border-b border-slate-100 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-slate-900 animate-fade-in">Gerenciar Variações</h2>
                <p className="text-xs text-slate-500 mt-0.5">Produto: <span className="font-semibold text-slate-800">{activeVariationsProduct.name}</span></p>
              </div>
              <button 
                onClick={() => setSelectedProductForVariations(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
                title="Fechar"
              >
                <X size={18} />
              </button>
            </div>

            {/* Quick Apply Reusable Model */}
            {variationGroups.length > 0 && (
              <div className="bg-slate-50 p-4 border-b border-slate-100 shrink-0 flex flex-col md:flex-row md:items-center justify-between gap-3">
                <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5 shrink-0">
                  <Layers size={14} className="text-blue-600" />
                  Aplicar Modelo de Variação:
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {variationGroups.map(g => (
                    <button
                      key={g.id}
                      type="button"
                      onClick={() => {
                        applyGroupToSingleProduct(g.id, activeVariationsProduct.id);
                      }}
                      className="text-[10px] bg-white hover:bg-blue-50 text-slate-700 font-bold border border-slate-200 hover:border-blue-300 hover:text-blue-700 px-2.5 py-1 rounded-lg transition-all cursor-pointer shadow-sm active:scale-95 flex items-center gap-1"
                      title={`Aplicar opções de: ${g.name}`}
                    >
                      <span>{g.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {(!activeVariationsProduct.variations || activeVariationsProduct.variations.length === 0) ? (
                <div className="text-center py-12 text-slate-400 border-2 border-dashed border-slate-200 rounded-2xl p-6 bg-slate-50/50">
                  <Layers size={40} className="mx-auto mb-3 opacity-20 text-slate-500" />
                  <p className="font-semibold text-slate-600">Nenhuma variação adicionada</p>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
                    Variações representam sabores, tamanhos ou opcionais deste item (ex: Coca-Cola, Fanta, Diet, Guaraná).
                  </p>
                  <button
                    type="button"
                    onClick={() => addVariation(activeVariationsProduct.id)}
                    className="mt-4 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-200 hover:bg-blue-100 hover:border-blue-300 px-3 py-2 rounded-lg transition-colors cursor-pointer"
                  >
                    <Plus size={14} />
                    Criar Primeira Variação
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="bg-blue-50/40 p-4 border border-blue-100 rounded-xl space-y-2">
                    <label className="block text-xs font-bold text-slate-700 uppercase tracking-wide">
                      Nome do Grupo de Variação (Reutilizável)
                    </label>
                    <input 
                      type="text"
                      value={activeVariationsProduct.variationGroupName || ''}
                      placeholder={`Ex: OPC - COPO E TIGELA (Padrão: OPC - ${activeVariationsProduct.name.substring(0, 15).toUpperCase()})`}
                      onChange={(e) => {
                        setProducts(prevProducts => prevProducts.map(p => 
                          p.id === activeVariationsProduct.id 
                            ? { ...p, variationGroupName: e.target.value } 
                            : p
                        ));
                      }}
                      className="w-full text-xs font-bold border border-slate-200 rounded-lg px-3 py-2 bg-white focus:ring-2 focus:ring-blue-500 outline-none transition-all text-slate-800"
                    />
                    <p className="text-[10px] text-slate-500 font-medium leading-tight">
                      Dica: Digite o MESMO nome de grupo para associar mais de um produto ao mesmo grupo (ex: se "Caldo de Feijão" e "Caldo de Frango" tiverem o grupo "<span className="font-bold">OPC - COPO E TIGELA</span>", o ERP reutilizará o grupo original e não criará duplicados!).
                    </p>
                  </div>

                  <div className="grid grid-cols-12 gap-3 text-xs font-bold text-slate-500 uppercase px-2">
                    <div className="col-span-8">Nome da Opção / Sabor</div>
                    <div className="col-span-3 text-right font-semibold text-slate-500">Preço (R$)</div>
                    <div className="col-span-1 text-center"></div>
                  </div>
                  
                  <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                    {activeVariationsProduct.variations.map((v, vIdx) => (
                      <div key={vIdx} className="grid grid-cols-12 gap-3 items-center bg-slate-50/70 hover:bg-slate-50 p-2.5 rounded-xl border border-slate-100 transition-colors">
                        <div className="col-span-8">
                          <input 
                            type="text"
                            value={v.name}
                            placeholder="Sabor, tamanho, etc. (ex: Laranja)"
                            onChange={(e) => handleVariationChange(activeVariationsProduct.id, vIdx, 'name', e.target.value)}
                            className="w-full text-sm border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-0.5 transition-colors bg-transparent outline-none font-medium text-slate-800"
                          />
                        </div>
                        <div className="col-span-3">
                          <input 
                            type="number"
                            step="0.01"
                            value={v.price}
                            placeholder="0.00"
                            onChange={(e) => handleVariationChange(activeVariationsProduct.id, vIdx, 'price', parseFloat(e.target.value) || 0)}
                            className="w-full text-sm text-right border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-0.5 transition-colors bg-transparent outline-none font-semibold text-blue-600"
                          />
                        </div>
                        <div className="col-span-1 flex justify-center">
                          <button 
                            type="button"
                            onClick={() => removeVariation(activeVariationsProduct.id, vIdx)}
                            className="p-1 rounded hover:bg-rose-50 text-slate-400 hover:text-rose-500 transition-colors cursor-pointer"
                            title="Remover"
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-slate-100 bg-slate-50/50 shrink-0 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <button 
                  type="button"
                  onClick={() => addVariation(activeVariationsProduct.id)}
                  className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-3.5 py-2 rounded-lg transition-colors border border-blue-100 cursor-pointer"
                >
                  <Plus size={14} />
                  Adicionar Opção
                </button>

                {activeVariationsProduct.variations && activeVariationsProduct.variations.length > 0 && (
                  <button 
                    type="button"
                    onClick={() => {
                      const defaultName = activeVariationsProduct.variationGroupName || `Modelo ${activeVariationsProduct.name}`;
                      setEditingGroup({
                        id: generateId(),
                        name: defaultName,
                        description: `Serve para determinar tamanho`,
                        targetProductsType: `${activeVariationsProduct.name}`,
                        variations: (activeVariationsProduct.variations || []).map(v => ({ ...v }))
                      });
                    }}
                    className="flex items-center gap-1.5 text-xs font-semibold text-green-700 hover:text-green-800 bg-green-50 hover:bg-green-100 px-3.5 py-2 rounded-lg transition-colors border border-green-200 cursor-pointer"
                    title="Salvar esta lista como um modelo reaproveitável"
                  >
                    <Save size={14} />
                    Salvar como Modelo
                  </button>
                )}
              </div>

              <button 
                type="button"
                onClick={() => setSelectedProductForVariations(null)}
                className="px-5 py-2 text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg transition-colors shadow-sm cursor-pointer"
              >
                Concluir
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Modal - Cadastrar/Editar Modelo de Variação (editingGroup) */}
      {editingGroup && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-xl w-full max-w-lg border border-slate-200 flex flex-col max-h-[85vh]"
          >
            <div className="flex items-center justify-between p-5 border-b border-slate-100 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-slate-900">
                  {variationGroups.some(g => g.id === editingGroup.id) ? 'Editar Modelo de Variação' : 'Criar Modelo de Variação'}
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">Defina opções e preços para aplicar em qualquer produto.</p>
              </div>
              <button 
                onClick={() => setEditingGroup(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-1.5">Nome do Modelo (ex: Copos e Tigelas, Sabores)</label>
                <input 
                  type="text"
                  value={editingGroup.name}
                  placeholder="Ex: Caldos, Sucos, Marmitas..."
                  onChange={(e) => setEditingGroup({ ...editingGroup, name: e.target.value })}
                  className="w-full text-sm border border-slate-200 rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors font-semibold bg-slate-50 focus:bg-white"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Por que salvou / Comentário</label>
                  <input 
                    type="text"
                    value={editingGroup.description || ''}
                    placeholder='Ex: "Serve para determinar tamanho"'
                    onChange={(e) => setEditingGroup({ ...editingGroup, description: e.target.value })}
                    className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-slate-50 focus:bg-white text-slate-700 font-medium"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-1">Para quais tipos de produto serve</label>
                  <input 
                    type="text"
                    value={editingGroup.targetProductsType || ''}
                    placeholder='Ex: "Copo e Tigela, Sorvete"'
                    onChange={(e) => setEditingGroup({ ...editingGroup, targetProductsType: e.target.value })}
                    className="w-full text-xs border border-slate-200 rounded-xl px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-blue-500 transition-colors bg-slate-50 focus:bg-white text-slate-700 font-medium"
                  />
                </div>
              </div>

              <div className="space-y-3">
                <div className="grid grid-cols-12 gap-3 text-xs font-bold text-slate-400 uppercase px-1">
                  <div className="col-span-8">Nome da Opção (ex: Copo, Tigela)</div>
                  <div className="col-span-3 text-right">Preço (R$)</div>
                  <div className="col-span-1"></div>
                </div>

                <div className="space-y-2 max-h-[30vh] overflow-y-auto pr-1">
                  {editingGroup.variations.map((v, idx) => (
                    <div key={idx} className="grid grid-cols-12 gap-3 items-center bg-slate-50 hover:bg-slate-100/80 p-2 rounded-xl border border-slate-100/80 transition-colors">
                      <div className="col-span-8">
                        <input 
                          type="text"
                          value={v.name}
                          placeholder="Ex: Copo"
                          onChange={(e) => {
                            const updated = [...editingGroup.variations];
                            updated[idx] = { ...updated[idx], name: e.target.value };
                            setEditingGroup({ ...editingGroup, variations: updated });
                          }}
                          className="w-full text-sm bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-0.5 outline-none font-medium"
                        />
                      </div>
                      <div className="col-span-3">
                        <input 
                          type="number"
                          step="0.01"
                          value={v.price}
                          placeholder="0.00"
                          onChange={(e) => {
                            const updated = [...editingGroup.variations];
                            updated[idx] = { ...updated[idx], price: parseFloat(e.target.value) || 0 };
                            setEditingGroup({ ...editingGroup, variations: updated });
                          }}
                          className="w-full text-sm text-right bg-transparent border-0 border-b border-transparent hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-0.5 outline-none font-semibold text-blue-600"
                        />
                      </div>
                      <div className="col-span-1 flex justify-center">
                        <button 
                          type="button"
                          disabled={editingGroup.variations.length <= 1}
                          onClick={() => {
                            const updated = [...editingGroup.variations];
                            updated.splice(idx, 1);
                            setEditingGroup({ ...editingGroup, variations: updated });
                          }}
                          className="p-1 rounded text-slate-400 hover:text-rose-500 hover:bg-rose-50 transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>

                <button 
                  type="button"
                  onClick={() => {
                    setEditingGroup({
                      ...editingGroup,
                      variations: [...editingGroup.variations, { name: '', price: 0 }]
                    });
                  }}
                  className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 border border-blue-200 hover:border-blue-300 px-3 py-1.5 rounded-lg transition-colors cursor-pointer"
                >
                  <Plus size={12} />
                  Adicionar Opção
                </button>
              </div>
            </div>

            <div className="p-5 border-t border-slate-100 bg-slate-50/55 shrink-0 flex gap-3">
              <button 
                onClick={() => setEditingGroup(null)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                onClick={() => {
                  if (!editingGroup.name.trim()) {
                    showToast('Por favor, informe o nome do modelo.', 'error');
                    return;
                  }
                  if (editingGroup.variations.some(v => !v.name.trim())) {
                    showToast('Por favor, informe o nome de todas as opções de variações.', 'error');
                    return;
                  }
                  createOrUpdateGroup(editingGroup);
                  showToast('Modelo de variação editado com sucesso!', 'success');
                }}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm cursor-pointer"
              >
                Salvar Modelo
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Modal - Aplicar Modelo em Massa (applyingGroupToProducts) */}
      {applyingGroupToProducts && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-xl w-full max-w-lg border border-slate-200 flex flex-col max-h-[85vh]"
          >
            <div className="flex items-center justify-between p-5 border-b border-slate-100 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-1.5">
                  <Layers size={18} className="text-blue-600" />
                  Associar Modelo a Produtos
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">Modelo: <span className="font-bold text-blue-800">{applyingGroupToProducts.name}</span></p>
              </div>
              <button 
                onClick={() => setApplyingGroupToProducts(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4 border-b border-slate-100">
              <div className="bg-blue-50/50 p-3.5 rounded-xl border border-blue-100 text-xs text-blue-800 leading-relaxed font-semibold">
                Selecione os produtos abaixo que devem receber as variações deste modelo ({applyingGroupToProducts.variations.map(v => `${v.name} - R$ ${v.price}`).join(', ')}):
              </div>

              {products.length === 0 ? (
                <div className="text-center py-10 text-slate-400 border border-dashed border-slate-200 rounded-xl">
                  Nenhum produto detectado na Fila de Conferência.
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between px-2 py-1 text-xs font-bold text-slate-400 uppercase">
                    <span>Lista de Produtos</span>
                    <button 
                      type="button" 
                      onClick={() => {
                        if (selectedApplyProdIds.length === products.length) {
                          setSelectedApplyProdIds([]);
                        } else {
                          setSelectedApplyProdIds(products.map(p => p.id));
                        }
                      }}
                      className="text-blue-600 hover:underline cursor-pointer"
                    >
                      {selectedApplyProdIds.length === products.length ? 'Desmarcar Todos' : 'Selecionar Todos'}
                    </button>
                  </div>
                  
                  <div className="max-h-[40vh] overflow-y-auto divide-y divide-slate-100 border border-slate-200/65 rounded-xl px-3 bg-slate-50/50">
                    {products.map(prod => {
                      const isChecked = selectedApplyProdIds.includes(prod.id);
                      return (
                        <label key={prod.id} className="flex items-center gap-3 py-2.5 cursor-pointer hover:bg-slate-50/40 select-none">
                          <input 
                            type="checkbox"
                            checked={isChecked}
                            onChange={() => {
                              if (isChecked) {
                                setSelectedApplyProdIds(selectedApplyProdIds.filter(id => id !== prod.id));
                              } else {
                                setSelectedApplyProdIds([...selectedApplyProdIds, prod.id]);
                              }
                            }}
                            className="rounded text-blue-600 focus:ring-blue-500 border-slate-300 w-4 h-4 cursor-pointer"
                          />
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-bold text-slate-800 truncate">{prod.name}</p>
                            <p className="text-[10px] text-slate-400 font-semibold">Preço base: R$ {prod.price} | Cód: {prod.barcode}</p>
                          </div>
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className="p-5 border-t border-slate-100 bg-slate-50/55 shrink-0 flex gap-3">
              <button 
                onClick={() => setApplyingGroupToProducts(null)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                Voltar
              </button>
              <button 
                onClick={() => {
                  if (selectedApplyProdIds.length === 0) {
                    showToast('Por favor, selecione pelo menos um produto para associar.', 'error');
                    return;
                  }
                  applyGroupToMultipleProducts(applyingGroupToProducts.id, selectedApplyProdIds);
                  showToast('Modelo de variações associado com sucesso!', 'success');
                }}
                disabled={selectedApplyProdIds.length === 0}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm cursor-pointer"
              >
                Associar ({selectedApplyProdIds.length})
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Floating In-App Toast Notification */}
      {toast && (
        <motion.div 
          initial={{ opacity: 0, y: -20, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          className={`fixed top-5 right-5 z-[200] p-4 rounded-xl shadow-xl border flex items-center gap-3 max-w-sm ${
            toast.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' :
            toast.type === 'error' ? 'bg-rose-50 border-rose-200 text-rose-800' :
            'bg-blue-50 border-blue-200 text-blue-800'
          }`}
        >
          <div className="text-sm font-bold">
            {toast.type === 'success' && '✓'}
            {toast.type === 'error' && '✕'}
            {toast.type === 'info' && 'ℹ'}
          </div>
          <p className="text-xs font-semibold leading-relaxed">{toast.message}</p>
          <button 
            onClick={() => setToast(null)}
            className="text-slate-400 hover:text-slate-600 ml-auto p-1 font-bold text-sm cursor-pointer"
          >
            ×
          </button>
        </motion.div>
      )}

      {/* Modal - Customizar / Selecionar Imagem do Produto */}
      {selectedImageProduct && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white rounded-2xl shadow-xl w-full max-w-xl border border-slate-200 flex flex-col max-h-[90vh] overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 shrink-0">
              <div>
                <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <svg className="w-5 h-5 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  Editar Foto do Produto
                </h2>
                <p className="text-xs text-slate-500 mt-0.5">Defina a foto que melhor representa o item no App de Delivery</p>
              </div>
              <button 
                onClick={() => setSelectedImageProduct(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer text-sm"
              >
                <X size={18} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Main Preview with product information */}
              <div className="flex flex-col md:flex-row gap-5 bg-slate-50 p-4 rounded-2xl border border-slate-150 items-center md:items-start select-none">
                <div className="w-24 h-24 rounded-xl border border-slate-200 overflow-hidden shrink-0 bg-slate-200 shadow-sm flex items-center justify-center relative">
                  {editedImageUrl ? (
                    <img 
                      src={editedImageUrl} 
                      alt="Preview" 
                      className="w-full h-full object-cover" 
                      referrerPolicy="no-referrer"
                      onError={(e) => {
                        e.currentTarget.src = "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=200&auto=format&fit=crop&q=60";
                      }}
                    />
                  ) : (
                    <svg className="w-8 h-8 text-slate-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                    </svg>
                  )}
                </div>
                <div className="flex-1 min-w-0 text-center md:text-left">
                  <h4 className="text-base font-bold text-slate-800 truncate">{selectedImageProduct.name}</h4>
                  <p className="text-xs text-slate-500 mt-0.5 font-semibold">Preço: <span className="text-blue-600">R$ {selectedImageProduct.price}</span> | Código de barras: <span className="font-mono text-slate-600 font-bold">{selectedImageProduct.barcode || 'Nenhum'}</span></p>
                  
                  {/* Edit manually URL input */}
                  <div className="mt-3.5 space-y-1 text-left">
                    <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider">URL Direta da Imagem</label>
                    <input 
                      type="text"
                      className="w-full text-xs font-medium border border-slate-200 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-1.5 focus:ring-blue-500 focus:border-blue-500 outline-none transition-colors"
                      placeholder="Cole uma URL direta da internet aqui..."
                      value={editedImageUrl}
                      onChange={(e) => setEditedImageUrl(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* Suggestions Section */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h5 className="text-xs font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
                    <svg className="w-4 h-4 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    Sugestões Inteligentes da IA
                  </h5>

                  <button
                    type="button"
                    disabled={selectedImageProduct.isSearchingImage}
                    onClick={() => triggerImageSearch(selectedImageProduct, customSearchTerm)}
                    className="text-[11px] font-bold text-blue-600 hover:text-blue-700 bg-blue-50 hover:bg-blue-100 px-3 py-1.5 rounded-lg border border-blue-200 cursor-pointer flex items-center gap-1 transition-all disabled:opacity-50"
                  >
                    {selectedImageProduct.isSearchingImage ? (
                      <>
                        <Loader2 size={12} className="animate-spin text-blue-600" />
                        <span>Buscando...</span>
                      </>
                    ) : (
                      <>
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 1121.21 15.153M20 30h-1" />
                        </svg>
                        <span>Sugerir Outra</span>
                      </>
                    )}
                  </button>
                </div>

                {/* Term customize box */}
                <div className="flex items-center gap-2 bg-slate-50/70 p-2.5 rounded-lg border border-slate-100">
                  <span className="text-[10px] uppercase font-bold text-slate-400 shrink-0">Buscar por:</span>
                  <input 
                    type="text"
                    value={customSearchTerm}
                    onChange={(e) => setCustomSearchTerm(e.target.value)}
                    placeholder="Altere o termo para buscar novas fotos..."
                    className="flex-1 bg-transparent border-0 border-b border-slate-200 hover:border-slate-300 focus:border-blue-500 focus:ring-0 py-0.5 px-1 font-bold text-xs outline-none text-slate-700"
                  />
                </div>

                {selectedImageProduct.candidateImages && selectedImageProduct.candidateImages.length > 0 ? (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {selectedImageProduct.candidateImages.map((url, i) => (
                      <div 
                        key={i} 
                        onClick={() => setEditedImageUrl(url)}
                        className={`relative group h-20 rounded-xl overflow-hidden border cursor-pointer bg-slate-100 flex items-center justify-center transition-all ${
                          editedImageUrl === url 
                            ? 'ring-4 ring-blue-500 border-transparent scale-[1.03]' 
                            : 'hover:scale-[1.02] border-slate-200 hover:border-slate-300'
                        }`}
                      >
                        <img src={url} alt={`Option ${i+1}`} className="w-full h-full object-cover" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.src = "https://images.unsplash.com/photo-1546069901-ba9599a7e63c?w=150&auto=format&fit=crop&q=60"; }} />
                        <div className={`absolute inset-0 bg-blue-600/10 flex items-center justify-center transition-opacity ${editedImageUrl === url ? 'opacity-100' : 'opacity-0 group-hover:opacity-40'}`}>
                          {editedImageUrl === url && (
                            <div className="bg-blue-600 text-white rounded-full p-1 shadow-md animate-bounce-short">
                              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-8 text-slate-400 border border-dashed border-slate-200 rounded-xl bg-slate-50/50 p-4">
                    <p className="text-xs font-bold text-slate-500">Nenhuma imagem carregada ainda</p>
                    <p className="text-[10px] text-slate-400 mt-1">Clique no botão "Sugerir Outra" para que a IA busque 4 opções profissionais baseadas no nome do prato.</p>
                  </div>
                )}
              </div>
            </div>

            {/* Actions Footer */}
            <div className="p-5 border-t border-slate-100 bg-slate-50/50 shrink-0 flex gap-3">
              <button 
                onClick={() => setSelectedImageProduct(null)}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                onClick={() => {
                  setProducts(prev => prev.map(p => {
                    if (p.id === selectedImageProduct.id) {
                      return {
                        ...p,
                        imageUrl: editedImageUrl,
                        candidateImages: selectedImageProduct.candidateImages
                      };
                    }
                    return p;
                  }));
                  setSelectedImageProduct(null);
                  showToast('Imagem do produto atualizada com sucesso!', 'success');
                }}
                className="flex-1 px-4 py-2.5 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm cursor-pointer"
              >
                Confirmar Alteração
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Confirmation Modal */}
      {confirmModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-[210] p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white p-6 rounded-2xl shadow-xl w-full max-w-sm border border-slate-200"
          >
            <div className="flex items-start gap-3 mb-4">
              <div className="w-8 h-8 rounded-full bg-rose-50 flex items-center justify-center text-rose-500 shrink-0 text-lg font-bold">!</div>
              <div>
                <h3 className="text-sm font-bold text-slate-900">Confirmação</h3>
                <p className="text-xs text-slate-500 mt-1 leading-relaxed">{confirmModal.message}</p>
              </div>
            </div>
            <div className="flex gap-3">
              <button 
                onClick={() => setConfirmModal(null)}
                className="flex-1 px-4 py-2.5 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                onClick={() => {
                  confirmModal.onConfirm();
                  setConfirmModal(null);
                }}
                className="flex-1 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 hover:bg-rose-700 rounded-xl transition-colors shadow-sm cursor-pointer"
              >
                Confirmar
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* Custom Name / Text Prompt Modal */}
      {promptModal && (
        <div className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center z-[210] p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white p-6 rounded-2xl shadow-xl w-full max-w-sm border border-slate-200"
          >
            <h3 className="text-sm font-bold text-slate-900 mb-2">{promptModal.title}</h3>
            <p className="text-[11px] text-slate-400 font-semibold mb-4">Digite o nome da variação para salvá-la como modelo de atalho reutilizável.</p>
            <input 
              type="text"
              value={promptInputVal}
              onChange={(e) => setPromptInputVal(e.target.value)}
              placeholder={promptModal.placeholder || 'Digite um nome...'}
              className="w-full text-xs font-bold border border-slate-200 rounded-xl px-3.5 py-2.5 bg-slate-50 focus:bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all text-slate-800 mb-5"
              autoFocus
            />
            <div className="flex gap-3">
              <button 
                onClick={() => {
                  setPromptModal(null);
                  setPromptInputVal('');
                }}
                className="flex-1 px-4 py-2.5 text-xs font-bold text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-xl transition-colors cursor-pointer"
              >
                Cancelar
              </button>
              <button 
                onClick={() => {
                  promptModal.onConfirm(promptInputVal);
                  setPromptModal(null);
                  setPromptInputVal('');
                }}
                className="flex-1 px-4 py-2.5 text-xs font-bold text-white bg-blue-600 hover:bg-blue-700 rounded-xl transition-colors shadow-sm cursor-pointer"
              >
                Confirmar
              </button>
            </div>
          </motion.div>
        </div>
      )}
    </div>
  );
}
