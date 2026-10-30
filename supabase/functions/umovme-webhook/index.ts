// Setup type definitions for Deno runtime
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Helper para padronizar slugs
function slugify(text: string): string {
  if (!text) return "";
  return text
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

Deno.serve(async (req) => {
  // CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, apikey"
      }
    });
  }

  try {
    const url = new URL(req.url);
    const cleanPath = url.pathname.replace(/^.*\/umovme-webhook\/?/i, "");
    const pathParts = cleanPath.split("/").filter(Boolean);
    let urlClient = pathParts[0] || url.searchParams.get("client") || url.searchParams.get("cliente") || null;
    let urlNetwork = pathParts[1] || url.searchParams.get("network") || url.searchParams.get("rede") || null;

    if (urlClient && urlClient.toLowerCase() === "umovme-webhook") {
      urlClient = pathParts[1] || null;
      urlNetwork = pathParts[2] || null;
    }

    // Obter payload
    let rawPayload: any = {};
    const contentType = req.headers.get("content-type") || "";

    if (contentType.includes("application/json")) {
      rawPayload = await req.json();
    } else if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await req.formData();
      const obj: any = {};
      formData.forEach((val, key) => { obj[key] = val; });
      rawPayload = obj;
    } else {
      const text = await req.text();
      try {
        rawPayload = JSON.parse(text);
      } catch {
        rawPayload = { rawText: text };
      }
    }

    // Inicializar cliente Supabase interno
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Normalizar dados da atividade
    const root = rawPayload.activity || rawPayload.data || rawPayload.evento || rawPayload;

    // Extrair fotos de todo o payload (suporte a múltiplas URLs separadas por ';' ou grudadas)
    const photoUrls: string[] = [];
    const inspectString = (str: string) => {
      if (typeof str !== "string" || !str.includes("http")) return;
      const matches = str.match(/https?:\/\/(?:(?!https?:\/\/)[^\s;"'<>])+/gi) || [];
      for (const m of matches) {
        const clean = m.trim();
        if (clean.startsWith("http") && (clean.includes("picviewer.umov.me") || clean.includes("/Pic/") || clean.includes("/files/") || clean.match(/\.(jpe?g|png|webp|gif)/i))) {
          if (!photoUrls.includes(clean)) photoUrls.push(clean);
        }
      }
    };

    const inspectValue = (val: any) => {
      if (!val) return;
      if (typeof val === "string") inspectString(val);
      else if (Array.isArray(val)) val.forEach(inspectValue);
      else if (typeof val === "object") {
        if (val.url) inspectString(val.url);
        if (val.link) inspectString(val.link);
        if (val.fileUrl) inspectString(val.fileUrl);
        if (val.answer) inspectString(val.answer);
        Object.values(val).forEach(inspectValue);
      }
    };

    [root, rawPayload].forEach(inspectValue);

    // ID da atividade
    let activityId = "UMOV-" + Date.now();
    if (rawPayload.correlationid) activityId = String(rawPayload.correlationid);
    else if (root.id && !String(root.id).startsWith("http")) activityId = String(root.id);
    else if (photoUrls.length > 0) {
      const matchId = photoUrls[0].match(/id=(\d+)/i);
      if (matchId && matchId[1]) activityId = `UMOV-${matchId[1]}`;
    }

    // Promotor (suporte a taskId: "EVELYN NASCIMENTO")
    const agentObj = root.agent || root.usuario || root.promotor || root.user || {};
    let promoterName = agentObj.name || agentObj.nome || root.agentName || root.promoterName || root.promotor;
    if (!promoterName && root.taskId && typeof root.taskId === "string" && !root.taskId.startsWith("http")) {
      promoterName = root.taskId;
    }
    promoterName = (promoterName || "Promotor de Campo").trim();

    // Data (suporte a historyId: "2026-10-29 14:14:51;OBJETIVA MARKETING;")
    let dateStr = root.endDate || root.dataFim || root.executionDate || root.date;
    if (!dateStr && root.historyId && typeof root.historyId === "string") {
      const parts = root.historyId.split(";");
      if (parts[0] && parts[0].includes("-")) dateStr = parts[0].trim();
    }
    if (!dateStr) dateStr = new Date().toISOString();

    // Observações / Checklist (suporte a clientId: "NÃO;loja com produtos próximo ao vencimento")
    let notes = root.notes || root.observacoes || root.comment || "";
    if (!notes && root.clientId && typeof root.clientId === "string" && !root.clientId.startsWith("http")) {
      notes = root.clientId.split(";").map((p: string) => p.trim()).filter(Boolean).join(" | ");
    }
    if (!notes) notes = "Sem observações adicionais";

    // 4. Data, Loja e Rede do historyId
    const historyStr = String(root.historyId || rawPayload.historyId || "");
    let extractedStore = "";
    let extractedNetwork = "";

    if (historyStr) {
      const storeMatch = historyStr.match(/Loja:\s*([^;]+)/i);
      if (storeMatch && storeMatch[1]) extractedStore = storeMatch[1].trim();

      const razaoMatch = historyStr.match(/Raz[ãa]o\s*Social:\s*([^;]+)/i);
      if (!extractedStore && razaoMatch && razaoMatch[1]) extractedStore = razaoMatch[1].trim();

      const networkMatch = historyStr.match(/Rede:\s*([^;]+)/i);
      if (networkMatch && networkMatch[1]) extractedNetwork = networkMatch[1].trim();
    }

    // Cliente e Rede
    const localObj = root.local || root.client || root.pdv || root.store || root.cliente || {};
    let pdvName = (
      extractedStore ||
      localObj.fantasyName ||
      localObj.nomeFantasia ||
      localObj.name ||
      localObj.nome ||
      root.pdvName ||
      ""
    ).trim();

    let pdvCode = String(localObj.externalCode || localObj.codigo || localObj.code || root.pdvCode || "S/C").trim();
    let networkName = (urlNetwork || extractedNetwork || localObj.network || localObj.rede || localObj.chain || root.network || root.rede || "").trim();
    let clientName = (urlClient || localObj.clientName || root.clientName || root.marca || root.brand || root.cliente || "").trim();

    // Inferência inteligente se historyId tiver agência/rede
    const lowerHist = `${historyStr} ${pdvName}`.toLowerCase();
    if (!networkName || networkName === "229436480" || /^\d+$/.test(networkName)) {
      if (lowerHist.includes("zona sul")) networkName = "Zona Sul";
      else if (lowerHist.includes("mundial")) networkName = "Mundial";
      else if (lowerHist.includes("prezunic")) networkName = "Prezunic";
      else if (lowerHist.includes("guanabara")) networkName = "Guanabara";
      else if (lowerHist.includes("objetiva")) networkName = "Objetiva";
    }

    if (!clientName) clientName = urlClient || "Fresk";
    if (!pdvName) pdvName = networkName ? `Rede ${networkName}` : "Loja em Campo";

    // Tipo de Atividade
    const typeObj = root.activityType || root.tipoAtividade || root.task || {};
    const activityName = (typeObj.name || typeObj.description || root.activityName || "Execução e Auditoria em Loja").trim();

    // Buscar regras no banco Supabase para descobrir grupos de destino
    const { data: rules } = await supabase
      .from("regras_roteamento")
      .select("*")
      .eq("ativo", true);

    const matchedGroups = new Map<string, any>();
    const clientLower = clientName.toLowerCase();
    const networkLower = networkName.toLowerCase();
    const pdvLower = pdvName.toLowerCase();
    const incomingSlug = [urlClient, urlNetwork].filter(Boolean).map(slugify).join("/");

    // 1. Prioridade Máxima: Match direto pela URL dedicada gerada (route_slug)
    if (incomingSlug) {
      for (const rule of (rules || [])) {
        if (rule.route_slug && slugify(rule.route_slug) === incomingSlug) {
          matchedGroups.set(rule.grupo_whatsapp_id, { id: rule.grupo_whatsapp_id, name: rule.grupo_whatsapp_nome });
          if (rule.cliente) clientName = rule.cliente;
          if (rule.rede) networkName = rule.rede;
        }
      }
    }

    // 2. Se não encontrou por slug exato, avaliar combinação Cliente + Rede
    if (matchedGroups.size === 0) {
      for (const rule of (rules || [])) {
        if (rule.cliente && rule.rede) {
          const rClient = rule.cliente.toLowerCase();
          const rRede = rule.rede.toLowerCase();
          const clientMatches = clientLower.includes(rClient) || rClient.includes(clientLower) || slugify(clientName) === slugify(rule.cliente);
          const networkMatches = networkLower.includes(rRede) || pdvLower.includes(rRede) || rRede.includes(networkLower) || slugify(networkName) === slugify(rule.rede);
          if (clientMatches && networkMatches) {
            matchedGroups.set(rule.grupo_whatsapp_id, { id: rule.grupo_whatsapp_id, name: rule.grupo_whatsapp_nome });
            if (rule.cliente) clientName = rule.cliente;
            if (rule.rede) networkName = rule.rede;
          }
        }
      }
    }

    // 3. Fallback por cliente
    if (matchedGroups.size === 0) {
      for (const rule of (rules || [])) {
        if (rule.cliente && !rule.rede) {
          const rClient = rule.cliente.toLowerCase();
          if (clientLower.includes(rClient) || rClient.includes(clientLower) || slugify(clientName) === slugify(rule.cliente)) {
            matchedGroups.set(rule.grupo_whatsapp_id, { id: rule.grupo_whatsapp_id, name: rule.grupo_whatsapp_nome });
            if (rule.cliente) clientName = rule.cliente;
            break;
          }
        }
      }
    }

    const targetGroupsList = Array.from(matchedGroups.values());
    const initialStatus = targetGroupsList.length > 0 ? "PENDENTE" : "SEM_GRUPO";

    // Inserir registro na tabela atividades_umovme
    const { data: inserted, error: insertError } = await supabase
      .from("atividades_umovme")
      .insert({
        atividade_id: activityId,
        cliente: clientName,
        rede: networkName,
        pdv_nome: pdvName,
        pdv_codigo: pdvCode,
        promotor_nome: promoterName,
        tipo_atividade: activityName,
        observacoes: notes,
        data_execucao: dateStr,
        fotos: photoUrls,
        grupos_destino: targetGroupsList,
        status: initialStatus,
        erro: targetGroupsList.length === 0 ? "Nenhum grupo mapeado para este Cliente/Rede" : null,
        raw_payload: rawPayload
      })
      .select()
      .single();

    if (insertError) {
      console.error("Erro ao salvar no Supabase:", insertError);
      return new Response(JSON.stringify({ error: insertError.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: "Atividade salva com sucesso no Supabase e enfileirada para o WhatsApp!",
      atividade_id: activityId,
      cliente: clientName,
      rede: networkName,
      promotor: promoterName,
      fotos_total: photoUrls.length,
      status: initialStatus,
      grupos: targetGroupsList.map(g => g.name)
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }
});
