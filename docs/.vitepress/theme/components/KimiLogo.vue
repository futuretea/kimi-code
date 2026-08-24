<script setup lang="ts">
withDefaults(defineProps<{ size?: number }>(), { size: 56 })
</script>

<template>
  <span
    class="KimiLogo"
    :style="{ width: `${size}px`, height: `${size}px` }"
    aria-label="Tea Code"
    role="img"
  >T</span>
</template>

<style scoped>
.KimiLogo {
  display: grid;
  place-items: center;
  border-radius: 24%;
  background: var(--kimi-brand-gradient);
  color: white;
  font-size: 0.62em;
  font-weight: 800;
  line-height: 1;
}
</style>
