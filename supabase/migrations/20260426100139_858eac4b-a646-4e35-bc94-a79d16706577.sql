CREATE TYPE public.family_member_role AS ENUM ('ayah', 'ibu');
CREATE TYPE public.finance_entry_type AS ENUM ('income', 'expense', 'bill', 'debt', 'receivable', 'note', 'shopping');
CREATE TYPE public.finance_entry_status AS ENUM ('open', 'paid', 'deleted');

CREATE TABLE public.families (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  family_name TEXT NOT NULL CHECK (char_length(trim(family_name)) >= 2 AND char_length(family_name) <= 80),
  invite_code TEXT NOT NULL UNIQUE DEFAULT upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE public.family_members (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.family_member_role NOT NULL,
  display_name TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  UNIQUE (family_id, user_id)
);

CREATE TABLE public.chat_messages (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (char_length(trim(content)) > 0 AND char_length(content) <= 2000),
  kind TEXT NOT NULL DEFAULT 'user' CHECK (kind IN ('user', 'assistant', 'system')),
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE TABLE public.finance_entries (
  id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  family_id UUID NOT NULL REFERENCES public.families(id) ON DELETE CASCADE,
  member_id UUID NOT NULL REFERENCES public.family_members(id) ON DELETE CASCADE,
  source_message_id UUID REFERENCES public.chat_messages(id) ON DELETE SET NULL,
  type public.finance_entry_type NOT NULL,
  status public.finance_entry_status NOT NULL DEFAULT 'open',
  title TEXT NOT NULL CHECK (char_length(trim(title)) > 0 AND char_length(title) <= 180),
  amount NUMERIC(14, 2) DEFAULT 0 CHECK (amount >= 0),
  category TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  paid_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()
);

CREATE INDEX idx_family_members_user_id ON public.family_members(user_id);
CREATE INDEX idx_family_members_family_id ON public.family_members(family_id);
CREATE INDEX idx_chat_messages_family_created ON public.chat_messages(family_id, created_at DESC);
CREATE INDEX idx_finance_entries_family_date ON public.finance_entries(family_id, entry_date DESC);
CREATE INDEX idx_finance_entries_status ON public.finance_entries(family_id, status, type);

ALTER TABLE public.families ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.finance_entries ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER update_families_updated_at
BEFORE UPDATE ON public.families
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_family_members_updated_at
BEFORE UPDATE ON public.family_members
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER update_finance_entries_updated_at
BEFORE UPDATE ON public.finance_entries
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.is_family_member(_family_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.family_members
    WHERE family_id = _family_id
      AND user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.current_family_member_id(_family_id UUID)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT id
  FROM public.family_members
  WHERE family_id = _family_id
    AND user_id = auth.uid()
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.create_family(_family_name TEXT, _role public.family_member_role)
RETURNS TABLE(family_id UUID, invite_code TEXT, member_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_family_id UUID;
  new_invite_code TEXT;
  new_member_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF char_length(trim(_family_name)) < 2 OR char_length(trim(_family_name)) > 80 THEN
    RAISE EXCEPTION 'Nama keluarga harus 2-80 huruf';
  END IF;

  INSERT INTO public.families (family_name, created_by)
  VALUES (trim(_family_name), auth.uid())
  RETURNING id, families.invite_code INTO new_family_id, new_invite_code;

  INSERT INTO public.family_members (family_id, user_id, role)
  VALUES (new_family_id, auth.uid(), _role)
  RETURNING id INTO new_member_id;

  RETURN QUERY SELECT new_family_id, new_invite_code, new_member_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_family_by_code(_invite_code TEXT, _role public.family_member_role)
RETURNS TABLE(family_id UUID, family_name TEXT, member_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  found_family_id UUID;
  found_family_name TEXT;
  new_member_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  SELECT id, families.family_name
  INTO found_family_id, found_family_name
  FROM public.families
  WHERE invite_code = upper(trim(_invite_code))
  LIMIT 1;

  IF found_family_id IS NULL THEN
    RAISE EXCEPTION 'Kode keluarga tidak ditemukan';
  END IF;

  INSERT INTO public.family_members (family_id, user_id, role)
  VALUES (found_family_id, auth.uid(), _role)
  ON CONFLICT (family_id, user_id) DO UPDATE SET role = EXCLUDED.role, updated_at = now()
  RETURNING id INTO new_member_id;

  RETURN QUERY SELECT found_family_id, found_family_name, new_member_id;
END;
$$;

CREATE POLICY "Members can view their families"
ON public.families
FOR SELECT
TO authenticated
USING (public.is_family_member(id));

CREATE POLICY "Members can update their families"
ON public.families
FOR UPDATE
TO authenticated
USING (public.is_family_member(id))
WITH CHECK (public.is_family_member(id));

CREATE POLICY "Members can view family members"
ON public.family_members
FOR SELECT
TO authenticated
USING (public.is_family_member(family_id));

CREATE POLICY "Users can update their own family membership"
ON public.family_members
FOR UPDATE
TO authenticated
USING (user_id = auth.uid())
WITH CHECK (user_id = auth.uid());

CREATE POLICY "Members can view chat messages"
ON public.chat_messages
FOR SELECT
TO authenticated
USING (public.is_family_member(family_id));

CREATE POLICY "Members can create chat messages"
ON public.chat_messages
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_family_member(family_id)
  AND member_id = public.current_family_member_id(family_id)
);

CREATE POLICY "Members can delete chat messages"
ON public.chat_messages
FOR DELETE
TO authenticated
USING (public.is_family_member(family_id));

CREATE POLICY "Members can view finance entries"
ON public.finance_entries
FOR SELECT
TO authenticated
USING (public.is_family_member(family_id));

CREATE POLICY "Members can create finance entries"
ON public.finance_entries
FOR INSERT
TO authenticated
WITH CHECK (
  public.is_family_member(family_id)
  AND member_id = public.current_family_member_id(family_id)
);

CREATE POLICY "Members can update finance entries"
ON public.finance_entries
FOR UPDATE
TO authenticated
USING (public.is_family_member(family_id))
WITH CHECK (public.is_family_member(family_id));

CREATE POLICY "Members can delete finance entries"
ON public.finance_entries
FOR DELETE
TO authenticated
USING (public.is_family_member(family_id));

GRANT EXECUTE ON FUNCTION public.create_family(TEXT, public.family_member_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_family_by_code(TEXT, public.family_member_role) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_family_member(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_family_member_id(UUID) TO authenticated;