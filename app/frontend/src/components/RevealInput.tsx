import { useState, type ComponentProps } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Eye, EyeOff } from "lucide-react";

// The one password field with a reveal toggle (BACKLOG §6), used by the auth
// pages and the credential/notification panels. The toggle's aria-label is the
// bare "Show" / "Hide": it must never contain the field's label text, or a
// `getByLabel("Password")`-style locator (and a screen reader's label lookup)
// would see two candidates. The input's own label comes from the caller's
// <FieldLabel htmlFor={id}>.

type RevealInputProps = Omit<
  ComponentProps<"input">,
  "type" | "value" | "onChange"
> & {
  id: string;
  value: string;
  onChange: (value: string) => void;
};

export function RevealInput({
  value,
  onChange,
  autoComplete = "off",
  ...inputProps
}: RevealInputProps) {
  const [show, setShow] = useState(false);
  return (
    <InputGroup>
      <InputGroupInput
        {...inputProps}
        type={show ? "text" : "password"}
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          size="icon-xs"
          aria-label={show ? "Hide" : "Show"}
          onClick={() => setShow((s) => !s)}
        >
          {show ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
