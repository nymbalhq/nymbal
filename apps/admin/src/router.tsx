import { createBrowserRouter, redirect } from 'react-router-dom'
import { isAuthenticated } from '@/lib/auth'
import { AdminLayout } from '@/components/layout/AdminLayout'
import { LoginPage } from '@/pages/LoginPage'
import { DashboardPage } from '@/pages/DashboardPage'
import { OrdersListPage, ordersListHandle } from '@/pages/OrdersListPage'
import { OrderDetailPage, orderDetailHandle } from '@/pages/OrderDetailPage'
import { ProductsListPage, productsListHandle } from '@/pages/ProductsListPage'
import { ProductEditPage, productEditHandle, productNewHandle } from '@/pages/ProductEditPage'
import { InventoryPage, inventoryHandle } from '@/pages/InventoryPage'
import { CustomersListPage, customersListHandle } from '@/pages/CustomersListPage'
import { CustomerDetailPage, customerDetailHandle } from '@/pages/CustomerDetailPage'
import { NotFoundPage } from '@/pages/NotFoundPage'

function authLoader() {
  if (!isAuthenticated()) {
    return redirect('/admin/login')
  }
  return null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const router: ReturnType<typeof createBrowserRouter> = createBrowserRouter(
  [
    {
      path: '/login',
      element: <LoginPage />,
    },
    {
      path: '/',
      element: <AdminLayout />,
      loader: authLoader,
      handle: { breadcrumb: () => null },
      children: [
        {
          index: true,
          element: <DashboardPage />,
          handle: { breadcrumb: () => 'Dashboard' },
        },
        {
          path: 'orders',
          handle: ordersListHandle,
          children: [
            {
              index: true,
              element: <OrdersListPage />,
            },
            {
              path: ':orderNumber',
              element: <OrderDetailPage />,
              handle: orderDetailHandle,
            },
          ],
        },
        {
          path: 'products',
          handle: productsListHandle,
          children: [
            {
              index: true,
              element: <ProductsListPage />,
            },
            {
              path: 'new',
              element: <ProductEditPage />,
              handle: productNewHandle,
            },
            {
              path: ':slug',
              element: <ProductEditPage />,
              handle: productEditHandle,
            },
          ],
        },
        {
          path: 'inventory',
          element: <InventoryPage />,
          handle: inventoryHandle,
        },
        {
          path: 'customers',
          handle: customersListHandle,
          children: [
            {
              index: true,
              element: <CustomersListPage />,
            },
            {
              path: ':id',
              element: <CustomerDetailPage />,
              handle: customerDetailHandle,
            },
          ],
        },
        {
          path: '*',
          element: <NotFoundPage />,
        },
      ],
    },
  ],
  {
    basename: '/admin',
  }
)
