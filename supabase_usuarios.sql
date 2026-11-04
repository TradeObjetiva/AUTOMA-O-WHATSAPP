-- ============================================================================
-- TABELA DE USUÁRIOS DO SISTEMA - TRADE MARKETING HUB (OBJETIVA MARKETING)
-- Cole este script no "SQL Editor" do seu Supabase e clique em "Run"
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.usuarios (
  id TEXT PRIMARY KEY,
  usuario TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  nome TEXT NOT NULL,
  senha TEXT NOT NULL,
  cargo TEXT NOT NULL DEFAULT 'operador',
  status TEXT NOT NULL DEFAULT 'APPROVED',
  ativo BOOLEAN NOT NULL DEFAULT true,
  ultimo_login TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Liberar leitura e gravação pela API do sistema (Row Level Security)
ALTER TABLE public.usuarios ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Acesso sistema tabela usuarios" ON public.usuarios;
CREATE POLICY "Acesso sistema tabela usuarios"
  ON public.usuarios
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Inserir os usuários administradores padrão da Objetiva Marketing
INSERT INTO public.usuarios (id, usuario, email, nome, senha, cargo, status, ativo)
VALUES
  (
    'user-admin-master',
    'admin',
    'inteligencia.trade@objetivamkt.com.br',
    'Fabiano Pereira (Admin)',
    'Objetiva@2026',
    'admin',
    'APPROVED',
    true
  ),
  (
    'user-admin-objetiva',
    'objetiva',
    'objetiva.mkt@gmail.com',
    'Objetiva Marketing',
    'Objetiva@2026',
    'admin',
    'APPROVED',
    true
  )
ON CONFLICT (id) DO UPDATE SET
  usuario = EXCLUDED.usuario,
  email = EXCLUDED.email,
  nome = EXCLUDED.nome,
  cargo = EXCLUDED.cargo,
  status = 'APPROVED',
  ativo = true;
