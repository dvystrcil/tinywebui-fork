<script setup lang="ts">
/**
 * A tool call held for the person's approval, inline in the turn rather than
 * inside the activity: the run is waiting on it. The buttons stay (locked)
 * until the server confirms with approval_done, so every tab watching the run
 * settles together.
 */
import { computed, ref } from 'vue';
import { toolLabel, toolParts, type Approval, type ToolStep } from '../../model/turn_model.ts';
import { useChat } from '../../stores/chat.ts';

const props = defineProps<{ pending: Approval, step?: ToolStep }>();
const chat = useChat();
const locked = ref(false);

async function decide(decision: 'allow' | 'always' | 'deny') {
  locked.value = true;
  try { await chat.approve(props.pending.callId, decision); } catch (err) {
    locked.value = false;
    chat.addError(err.message);
  }
}
// The server is shown too: two servers can expose the same short name, and
// only one of them may be the tool you are being asked about.
const parts = computed(() => toolParts(props.pending.name));
</script>

<template>
  <div class="prompt-card approval" role="group" :aria-label="`Approve ${toolLabel(pending.name)}`">
    <div class="prompt-head">
      <span class="prompt-kicker">Needs your approval</span>
      <span class="prompt-title"><code>{{ parts.tool }}</code><span v-if="parts.server" class="prompt-server"> · {{ parts.server }}</span> wants to run</span>
    </div>
    <details v-if="step" class="prompt-args">
      <summary>{{ step.arg || 'arguments' }}</summary>
      <pre>{{ step.args }}</pre>
    </details>
    <div class="prompt-actions">
      <button type="button" class="primary" :disabled="locked" @click="decide('allow')">Allow</button>
      <button type="button" :disabled="locked" @click="decide('always')">Always allow this tool</button>
      <button type="button" class="quiet" :disabled="locked" @click="decide('deny')">Deny</button>
    </div>
  </div>
</template>
