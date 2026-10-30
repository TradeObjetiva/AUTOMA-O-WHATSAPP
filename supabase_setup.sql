-- ==============================================================
-- SCHEMA SUPABASE: TRADE MARKETING (UMOV.ME ➔ WHATSAPP)
-- Cole e execute este script no "SQL Editor" do painel do Supabase
-- ==============================================================

-- 1. Tabela de Regras de Mapeamento (Cliente x Rede ➔ Grupo de WhatsApp)
CREATE TABLE IF NOT EXISTS public.regras_roteamento (
    id TEXT PRIMARY KEY,
    nome TEXT NOT NULL,
    cliente TEXT NOT NULL,
    rede TEXT DEFAULT '',
    route_slug TEXT DEFAULT '',
    grupo_whatsapp_id TEXT NOT NULL,
    grupo_whatsapp_nome TEXT NOT NULL,
    ativo BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Inserir regras iniciais do seu WhatsApp
INSERT INTO public.regras_roteamento (id, nome, cliente, rede, route_slug, grupo_whatsapp_id, grupo_whatsapp_nome, ativo)
VALUES
    ('rule-fantastico-mundial', 'Arroz Fantástico - Rede Mundial', 'Arroz Fantástico', 'Mundial', 'arroz-fantastico/mundial', '120363423999295708@g.us', 'ARROZ FANTÁSTICO MUNDIAL', true),
    ('rule-fantastico-geral', 'Arroz Fantástico - Geral', 'Arroz Fantástico', '', 'arroz-fantastico', '120363421654515467@g.us', 'ARROZ FANTÁSTICO- OBJETIVA RJ', true),
    ('rule-fresk-objetiva', 'Fresk - Rede Objetiva', 'Fresk', 'Objetiva', 'fresk/objetiva', '120363429489147083@g.us', 'Teste fresk', true),
    ('rule-reserva-mundial', 'Reserva de Minas - Rede Mundial', 'Reserva de Minas', 'Mundial', 'reserva-de-minas/mundial', '120363424323586858@g.us', 'RESERVA DE MINAS -MUNDIAL', true),
    ('rule-reserva-prezunic', 'Reserva de Minas - Rede Prezunic', 'Reserva de Minas', 'Prezunic', 'reserva-de-minas/prezunic', '120363393946676739@g.us', 'RESERVA DE MINAS - PREZUNIC', true),
    ('rule-kian-prezunic', 'Kian - Rede Prezunic', 'Kian', 'Prezunic', 'kian/prezunic', '5521985520529-1567606152@g.us', 'KIAN - PREZUNIC💡COMP', true),
    ('rule-kian-guanabara', 'Kian - Rede Guanabara', 'Kian', 'Guanabara', 'kian/guanabara', '120363201663364688@g.us', 'KIAN - GUANABARA 💡COMP', true)
ON CONFLICT (id) DO NOTHING;

-- 2. Tabela de Atividades Recebidas da uMov.me
CREATE TABLE IF NOT EXISTS public.atividades_umovme (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    atividade_id TEXT NOT NULL,
    cliente TEXT NOT NULL,
    rede TEXT DEFAULT '',
    pdv_nome TEXT,
    pdv_codigo TEXT,
    promotor_nome TEXT,
    tipo_atividade TEXT,
    observacoes TEXT,
    data_execucao TEXT,
    fotos JSONB DEFAULT '[]'::jsonb,
    grupos_destino JSONB DEFAULT '[]'::jsonb,
    status TEXT DEFAULT 'PENDENTE', -- PENDENTE, PROCESSANDO, ENVIADO, ERRO, SEM_GRUPO
    erro TEXT,
    raw_payload JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Índices para consulta rápida
CREATE INDEX IF NOT EXISTS idx_atividades_status ON public.atividades_umovme(status);
CREATE INDEX IF NOT EXISTS idx_atividades_cliente ON public.atividades_umovme(cliente);
CREATE INDEX IF NOT EXISTS idx_atividades_rede ON public.atividades_umovme(rede);

-- 3. Habilitar RLS e permitir leitura/escrita com a chave anon
ALTER TABLE public.regras_roteamento ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.atividades_umovme ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Acesso total regras anon" ON public.regras_roteamento FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY "Acesso total atividades anon" ON public.atividades_umovme FOR ALL USING (true) WITH CHECK (true);

-- 4. Habilitar Supabase Realtime para notificar novos registros na hora
ALTER PUBLICATION supabase_realtime ADD TABLE public.atividades_umovme;
