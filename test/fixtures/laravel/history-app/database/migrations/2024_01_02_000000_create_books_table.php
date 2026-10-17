<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('books', function (Blueprint $table) {
            $table->id();
            $table->unsignedBigInteger('writer_id');
            $table->foreign('writer_id')->references('id')->on('authors');
            $table->foreignId('editor_id')->nullable()->constrained('authors');
            $table->foreignId('reviewer_id')->nullable()->constrained('authors');
            $table->string('title');
            $table->string('isbn', 13);
            $table->timestamps();
        });

        Schema::create('temp_imports', function (Blueprint $table) {
            $table->longText('payload');
        });

        Schema::create('legacy_logs', function (Blueprint $table) {
            $table->string('line');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('legacy_logs');
        Schema::dropIfExists('temp_imports');
        Schema::dropIfExists('books');
    }
};
