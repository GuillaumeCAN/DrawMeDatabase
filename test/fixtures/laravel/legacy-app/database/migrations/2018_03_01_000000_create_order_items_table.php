<?php

use Illuminate\Support\Facades\Schema;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Database\Migrations\Migration;

class CreateOrderItemsTable extends Migration
{
    /**
     * Run the migrations.
     *
     * @return void
     */
    public function up()
    {
        Schema::create('products', function (Blueprint $table) {
            $table->bigIncrements('id');
            $table->string('sku', 32)->unique();
            $table->string('label');
            $table->unsignedDecimal('price', 10, 2);
            $table->softDeletes();
        });

        Schema::create('order_items', function (Blueprint $table) {
            $table->unsignedInteger('order_id');
            $table->unsignedBigInteger('product_id');
            $table->smallInteger('quantity')->default(1);
            $table->primary(['order_id', 'product_id']);
            $table->foreign(['order_id'])->references(['id'])->on('orders');
            $table->foreign('product_id', 'order_items_product_fk')->references('id')->on('products');
        });
    }

    /**
     * Reverse the migrations.
     *
     * @return void
     */
    public function down()
    {
        if (Schema::hasTable('order_items')) {
            Schema::table('order_items', function (Blueprint $table) {
                $table->dropForeign('order_items_product_fk');
            });
        }
        Schema::dropIfExists('order_items');
        Schema::dropIfExists('products');
    }
}
