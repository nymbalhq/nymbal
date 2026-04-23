import styles from '@/styles/pages/checkout.module.css'

const STEPS = [
  { label: 'Contact' },
  { label: 'Shipping' },
  { label: 'Payment' },
]

interface CheckoutStepsProps {
  currentStep: number
}

export function CheckoutSteps({ currentStep }: CheckoutStepsProps) {
  return (
    <div className={styles.steps} data-testid="checkout-steps">
      {STEPS.map((step, index) => {
        const isCompleted = index < currentStep
        const isActive = index === currentStep

        return (
          <div key={step.label} style={{ display: 'contents' }}>
            {index > 0 && (
              <div
                className={`${styles.stepConnector} ${
                  isCompleted ? styles.stepConnectorCompleted : ''
                }`}
              />
            )}
            <div
              className={`${styles.step} ${isActive ? styles.stepActive : ''} ${
                isCompleted ? styles.stepCompleted : ''
              }`}
            >
              <span className={styles.stepNumber}>
                {isCompleted ? (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                ) : (
                  index + 1
                )}
              </span>
              <span className={styles.stepLabel}>{step.label}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
