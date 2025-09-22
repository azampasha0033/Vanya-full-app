import {
  extension,
  Banner,
  BlockStack,
  InlineStack,
  TextField,
  Button,
  Text,
} from "@shopify/ui-extensions/checkout";

/** ===== CONFIG (real endpoints & token) ===== */
const SHOP_ID = "vanyaclothing";
const TOKEN =
  "DqB6eGqsnknTaVmmMiwAS3kPr8tgC4RgCPCNzNWxBaFNcAm2MbhHaFDQyAJqCCD845835359836C24A19D6D7F835";
const SEND_URL = "https://dialog-pay.com/api/v1/shopify/app/order-send-otp";
const VERIFY_URL = "https://dialog-pay.com/api/v1/shopify/app/order-verify-otp";
/** ========================================== */

export default extension(
  "purchase.checkout.delivery-address.render-after",
  (root, api) => {
    api.buyerJourney?.setCanBlockProgress?.({ canBlockProgress: true });

    // ----- State (local only; no checkout writes until verified) -----
    let phoneValue = "";
    let otpInput = "";
    let phoneConfirmed = false;
    let otpSent = false;

    let isVerified = false;
    let lastVerifiedAt = 0;

    let errorMsg = "";
    let verifiedMsg = "";
    let otpFeedbackMsg = "";
    let otpFeedbackKind = "info";

    // resend cooldown
    let resendUntil = 0;
    let cooldownTimer = null;

    // UI refs
    let containerRef = null;
    let resendBtnRef = null;
    let resendLabelTextRef = null;

    // loading flags
    let sending = false;
    let verifying = false;

    // ----- Helpers -----
    async function setAttr(key, value) {
      await api.applyAttributeChange({ type: "updateAttribute", key, value });
    }

    function getCountryIso() {
      const fromAddress = api.shippingAddress?.current?.countryCode;
      if (fromAddress) return String(fromAddress).toUpperCase();
      const fromLocalization = api.localization?.country?.isoCode;
      if (fromLocalization) return String(fromLocalization).toUpperCase();
      return undefined;
    }

    function getCallingCodeFromShopify(iso) {
      const list = api.localization?.availableCountries || [];
      const match = list.find((c) => String(c?.isoCode).toUpperCase() === iso);
      const code =
        (match && (match.phonePrefix || match.phone?.callingCode)) ||
        api.localization?.country?.phonePrefix ||
        api.localization?.country?.phone?.callingCode;
      if (typeof code === "string" && code.length)
        return code.startsWith("+") ? code : `+${code}`;
      return "+92"; // sensible default for your store
    }

    function stripWeirdMarks(s) {
      return (s || "").replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
    }

    function normalizePhone(raw) {
      const trimmed = stripWeirdMarks(raw).trim();
      if (!trimmed) return "";
      let s = trimmed.replace(/\s+/g, "");
      if (s.startsWith("+")) return s;
      if (s.startsWith("00")) return "+" + s.slice(2);
      s = s.replace(/\D/g, "");
      if (!s) return "";
      const iso = getCountryIso();
      const calling = getCallingCodeFromShopify(iso || "");
      const callingDigits = calling.replace("+", "");
      if (s.startsWith(callingDigits)) return `+${s}`;
      s = s.replace(/^0+/, "");
      if (!s) return "";
      return `${calling}${s}`;
    }

    function isLikelyValidPhone(s) {
      return /^\+\d{8,15}$/.test(s || "");
    }

    function secondsRemaining() {
      return Math.max(0, Math.ceil((resendUntil - Date.now()) / 1000));
    }

    function startResendCooldown(ms = 60000) {
      resendUntil = Date.now() + ms;
      updateResendVisual();
      if (cooldownTimer) clearInterval(cooldownTimer);
      cooldownTimer = setInterval(() => {
        if (Date.now() >= resendUntil) {
          clearInterval(cooldownTimer);
          cooldownTimer = null;
        }
        updateResendVisual();
      }, 1000);
    }

    function updateResendVisual() {
      if (!resendBtnRef || !resendLabelTextRef) return;
      const remaining = secondsRemaining();
      const disabled = remaining > 0 || sending;
      resendBtnRef.updateProps({ disabled });
      resendLabelTextRef.updateText(
        remaining > 0
          ? `Resend (${remaining}s)`
          : sending
          ? "Sending..."
          : "Resend"
      );
    }

    // Detect “already sent” type messages from server
    function isAlreadySentMessage(msg) {
      if (!msg) return false;
      const m = String(msg);
      return /otp.*already.*sent/i.test(m) || /already.*sent/i.test(m);
    }

    async function postJson(url, payload) {
      let res, text;
      try {
        res = await fetch(url, {
          method: "POST",
          mode: "cors",
          credentials: "omit",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${TOKEN}`,
          },
          body: JSON.stringify(payload),
        });
        text = await res.text();
      } catch (netErr) {
        throw new Error(`Network error: ${String(netErr)}`);
      }
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const msg =
          (data && (data.message || data.error || data.errors)) ||
          text ||
          `HTTP ${res.status} ${res.statusText}`;
        throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
      }
      return data || {};
    }

    async function sendOtp() {
      sending = true;
      errorMsg = "";
      verifiedMsg = "";
      otpFeedbackMsg = "";
      otpFeedbackKind = "info";
      updateResendVisual();
      renderUI();

      try {
        await postJson(SEND_URL, {
          shop_id: SHOP_ID,
          phone_number: phoneValue,
        });

        // No checkout attribute writes here.
        otpSent = true;
        isVerified = false;
        otpFeedbackMsg = `Code sent to ${phoneValue}.`;
        otpFeedbackKind = "info";
        startResendCooldown(60000);
      } catch (e) {
        const msg = String(e?.message || e || "");
        if (isAlreadySentMessage(msg)) {
          // ✅ Treat as success for UI: show OTP input, verify & (cooldown) resend
          otpSent = true;
          phoneConfirmed = true; // ensure OTP section is visible
          isVerified = false;

          // Friendly feedback (subdued, not critical)
          otpFeedbackMsg =
            `A code was recently sent to ${phoneValue}. ` +
            `Enter it below. You can resend after 60s.`;
          otpFeedbackKind = "subdued";

          // Start (or restart) a 60s cooldown so "Resend" is disabled
          startResendCooldown(60000);

          // Do NOT set errorMsg, we want the OTP UI, not a red error line
        } else {
          // Genuine failure
          otpSent = false;
          otpFeedbackMsg = msg;
          otpFeedbackKind = "critical";
        }
      } finally {
        sending = false;
        updateResendVisual();
        renderUI();
      }
    }

    // ----- Attribute sync (read-only; no writes here) -----
    api.attributes.subscribe((attributes) => {
      const get = (k) => attributes.find((a) => a.key === k)?.value;

      const attrPhone = get("customerPhone") || "";
      if (attrPhone && !phoneValue) {
        phoneValue = attrPhone;
      }

      const status = get("otpStatus");
      const attrSaysSent = status === "sent" || status === "verified";
      if (attrSaysSent && !otpSent) {
        otpSent = true;
      }

      const v = get("otpVerified");
      const attrVerified =
        v === true || v === "true" || v === "TRUE" || v === "True";
      if (attrVerified) {
        isVerified = true;
      } else if (Date.now() - lastVerifiedAt > 15000) {
        isVerified = false;
      }

      renderUI();
    });

    // ----- Handlers -----
    async function handlePhoneChange(val) {
      phoneValue = val;
      phoneConfirmed = false;
      otpSent = false;
      isVerified = false;
      errorMsg = "";
      verifiedMsg = "";
      renderUI();
    }

    async function handleConfirmPhone() {
      const normalized = normalizePhone(phoneValue);
      if (!isLikelyValidPhone(normalized)) {
        errorMsg = "Please enter a valid phone number (with country code).";
        verifiedMsg = "";
        phoneConfirmed = false;
        renderUI();
        return;
      }
      phoneValue = normalized;
      phoneConfirmed = true;
      errorMsg = "";
      verifiedMsg = "";

      await sendOtp();
    }

    async function handleResend() {
      if (!phoneConfirmed || !isLikelyValidPhone(phoneValue)) return;
      await sendOtp();
    }

    async function handleVerify() {
      if (!otpSent) {
        errorMsg = "Please request an OTP first.";
        verifiedMsg = "";
        renderUI();
        return;
      }
      const code = (otpInput || "").replace(/\s+/g, "");
      if (code.length !== 6) {
        errorMsg = "Enter the 6-digit code.";
        verifiedMsg = "";
        renderUI();
        return;
      }

      verifying = true;
      errorMsg = "";
      verifiedMsg = "";
      renderUI();

      try {
        const resp = await postJson(VERIFY_URL, {
          shop_id: SHOP_ID,
          phone_number: phoneValue,
          otp: code,
        });

        const failedExplicitly =
          resp &&
          (resp.success === false ||
            resp.verified === false ||
            resp.status === "error" ||
            resp.error === true);

        if (failedExplicitly) {
          throw new Error(resp?.message || "Verification failed.");
        }

        isVerified = true;
        lastVerifiedAt = Date.now();
        otpSent = false;
        otpInput = "";
        verifiedMsg = "OTP verified successfully";
        errorMsg = "";

        // ✅ Persist to checkout only once on success
        await setAttr("customerPhone", phoneValue);
        await setAttr("otpVerified", "true");
        await setAttr("otpStatus", "verified");

        renderUI();
      } catch (e) {
        isVerified = false;
        verifiedMsg = "";
        errorMsg =
          typeof e?.message === "string"
            ? e.message
            : "Invalid code. Please try again.";
      } finally {
        verifying = false;
        renderUI();
      }
    }

    // ----- Block checkout until verified -----
    api.buyerJourney?.intercept?.(({ canBlockProgress }) => {
      if (!canBlockProgress) return { behavior: "allow" };

      const hasLocalPhone = (phoneValue || "").trim().length > 0;
      const recentlyVerified =
        isVerified || Date.now() - lastVerifiedAt < 15000;

      if (hasLocalPhone && recentlyVerified) {
        return { behavior: "allow" };
      }

      if (hasLocalPhone && !recentlyVerified) {
        return {
          behavior: "block",
          reason: "phone_not_verified",
          errors: [
            {
              message:
                "Please verify your phone via WhatsApp OTP before paying.",
            },
          ],
        };
      }

      return {
        behavior: "block",
        reason: "phone_missing",
        errors: [
          {
            message:
              "Please add your phone number and verify it via WhatsApp OTP before paying.",
          },
        ],
      };
    });

    // ----- Render -----
    function renderUI() {
      const children = [];

      // Banner
      children.push(
        root.createComponent(BlockStack, { gap: "extraTight" }, [
          root.createComponent(
            Banner,
            { title: "WhatsApp Phone Verification", status: "info" },
            "We will send a one-time password (OTP) to your WhatsApp to verify your phone number. This is used only for order processing and fraud prevention, and not for marketing. Your data will be handled in line with privacy regulations (e.g., GDPR/CCPA)."
          ),
        ])
      );

      // Phone field
      children.push(
        root.createComponent(TextField, {
          label: "WhatsApp Phone Number e.g. +923000000000",
          type: "tel",
          value: phoneValue,
          onChange: handlePhoneChange,
          placeholder: "e.g. 0300 0000000 or +923000000000",
        })
      );

      // Error below phone field (only pre-OTP)
      if (errorMsg && !otpSent) {
        children.push(
          root.createComponent(Text, { appearance: "critical" }, errorMsg)
        );
      }

      // Feedback (e.g., "Code sent..." or "recently sent...")
      if (otpFeedbackMsg) {
        const appearance =
          otpFeedbackKind === "success"
            ? "success"
            : otpFeedbackKind === "critical"
            ? "critical"
            : "subdued";
        children.push(
          root.createComponent(Text, { appearance }, otpFeedbackMsg)
        );
      }

      // Confirm/Change button
      children.push(
        root.createComponent(InlineStack, { gap: "tight" }, [
          phoneConfirmed
            ? root.createComponent(
                Button,
                {
                  kind: "plain",
                  onPress: () => {
                    phoneConfirmed = false;
                    otpSent = false;
                    isVerified = false;
                    otpInput = "";
                    errorMsg = "";
                    verifiedMsg = "";
                    renderUI();
                  },
                  disabled: sending || verifying,
                },
                "Change Phone Number"
              )
            : root.createComponent(
                Button,
                {
                  kind: "secondary",
                  onPress: handleConfirmPhone,
                  disabled: sending || verifying,
                },
                "Confirm number"
              ),
        ])
      );

      // OTP field + Verify + Resend
      if (phoneConfirmed && phoneValue && !isVerified && otpSent) {
        const otpField = root.createComponent(TextField, {
          label: "Enter 6-digit OTP",
          inputMode: "numeric",
          maxLength: 6,
          value: otpInput,
          onChange: (v) => {
            otpInput = v;
          },
        });

        const verifyBtn = root.createComponent(
          Button,
          { kind: "primary", onPress: handleVerify, disabled: verifying },
          verifying ? "Verifying..." : "Verify"
        );

        resendLabelTextRef = root.createText(
          sending ? "Sending..." : `Resend (${secondsRemaining()}s)`
        );
        resendBtnRef = root.createComponent(
          Button,
          {
            kind: "secondary",
            onPress: handleResend,
            disabled: secondsRemaining() > 0 || sending,
          },
          resendLabelTextRef
        );
        updateResendVisual();

        children.push(
          root.createComponent(
            InlineStack,
            { gap: "tight", blockAlignment: "center" },
            [otpField, verifyBtn, resendBtnRef]
          )
        );

        // OTP-specific error under OTP field
        if (otpSent && errorMsg) {
          children.push(
            root.createComponent(Text, { appearance: "critical" }, errorMsg)
          );
        }
      }

      // Verified banner
      if (isVerified) {
        children.push(
          root.createComponent(
            Banner,
            { title: "Phone Verified", status: "success" },
            verifiedMsg || "Your phone number is verified successfully."
          )
        );
      }

      const tree = root.createComponent(
        BlockStack,
        { padding: "none", gap: "tight" },
        children
      );

      if (!containerRef) {
        containerRef = tree;
        root.appendChild(containerRef);
      } else {
        root.removeChild(containerRef);
        containerRef = tree;
        root.appendChild(containerRef);
      }
    }

    renderUI();
  }
);
